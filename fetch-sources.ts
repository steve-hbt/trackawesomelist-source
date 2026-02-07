import {
  getDayNumber,
  getDbCachedStars,
  getDbIndex,
  getDbMeta,
  getWeekNumber,
  sha1,
  writeDbCachedStars,
  writeDbIndex,
  writeDbMeta,
  writeJSONFile,
} from "./util.ts";
import parser from "./parser/mod.ts";
import log from "./log.ts";
import {
  FileInfo,
  Item,
  ParsedItemsFilePath,
  RepoMetaOverride,
  RunOptions,
} from "./interface.ts";
import initItems from "./init-items.ts";
import Github from "./adapters/github.ts";
import { getItems, updateFile, updateItems } from "./db.ts";
import renderMarkdown from "./render-markdown.ts";

export default async function (options: RunOptions) {
  const force = options.forceFetch;
  const isRebuild = options.rebuild;
  const config = options.config;
  const file_min_updated_hours = config.file_min_updated_hours;
  const sourcesMap = config.sources;

  let sourceIdentifiers = options.sourceIdentifiers;
  let isSpecificSource = true;

  if (sourceIdentifiers.length === 0) {
    isSpecificSource = false;
    sourceIdentifiers = Object.keys(sourcesMap);
  }

  const limit = options.limit;
  if (limit && limit > 0) {
    sourceIdentifiers = sourceIdentifiers.slice(0, limit);
  }

  const dbMeta = await getDbMeta();
  const dbIndex = await getDbIndex();
  const dbCachedStars = await getDbCachedStars();
  const dbSources = dbMeta.sources;

  const invalidFiles: ParsedItemsFilePath[] = [];
  let sourceIndex = 0;

  try {
    for (const sourceIdentifier of sourceIdentifiers) {
      sourceIndex++;

      try {
        log.info(
          `[${sourceIndex}/${sourceIdentifiers.length}] Fetching source: ${sourceIdentifier}`,
        );

        const source = sourcesMap[sourceIdentifier];
        if (!source) {
          log.warn(`[SKIP] Source ${sourceIdentifier} not found in config`);
          continue;
        }

        if (source.skip) {
          log.info(`source ${sourceIdentifier} is skipped`);
          continue;
        }

        const files = source.files;

        if (!dbSources[sourceIdentifier] || (isSpecificSource && isRebuild)) {
          await initItems(source, options, dbMeta, dbIndex, dbCachedStars);
          continue;
        } else {
          const dbSource = dbSources[sourceIdentifier];
          const dbFiles = dbSource.files;
          const dbFileKeys = Object.keys(dbFiles);
          const isAllFilesInit = Object.keys(files).every((file) =>
            dbFileKeys.includes(file)
          );
          if (!isAllFilesInit) {
            await initItems(source, options, dbMeta, dbIndex, dbCachedStars);
            continue;
          }
        }

        const dbSource = dbSources[sourceIdentifier];
        const dbFiles = dbSource.files;

        const api = new Github(source);
        const fileKeys = Object.keys(files);
        let fileIndex = 0;

        for (const file of fileKeys) {
          fileIndex++;
          const dbFileMeta = dbFiles[file];
          let needRebuild = false;

          if (dbFileMeta) {
            const dbFileMetaUpdatedAt = new Date(dbFileMeta.updated_at);
            if (dbFileMetaUpdatedAt.getTime() === 0) {
              log.info(
                `[${fileIndex}/${fileKeys.length}] ${sourceIdentifier}/${file} parsed failed, rebuild`,
              );
              needRebuild = true;
            }
          }

          if (!dbFileMeta) {
            needRebuild = true;
          }

          if (needRebuild) {
            await initItems(source, options, dbMeta, dbIndex, dbCachedStars);
            break;
          }

          const dbFileUpdated = new Date(dbFileMeta.checked_at);
          const now = new Date();
          const diff = now.getTime() - dbFileUpdated.getTime();

          if (!force && diff / 1000 / 60 / 60 < file_min_updated_hours) {
            log.info(
              `${fileIndex}/${fileKeys.length} ${sourceIdentifier}/${file} updated recently, skip`,
            );
            continue;
          }

          log.info(
            `${sourceIndex}/${sourceIdentifiers.length} updating ${sourceIdentifier}/${file}`,
          );

          const content = await api.getConent(
            file,
            source.default_branch,
          );

          const contentSha1 = await sha1(content);
          const dbFileSha1 = dbFileMeta.sha1;

          if (dbFileSha1 === contentSha1 && !force) {
            dbFileMeta.checked_at = now.toISOString();
            continue;
          }

          let items: Record<string, Item> = {};
          try {
            items = await getItems(sourceIdentifier, file);
          } catch {
            await initItems(source, options, dbMeta, dbIndex, dbCachedStars);
            continue;
          }

          const fileInfo: FileInfo = {
            sourceConfig: source,
            filepath: file,
            sourceMeta: dbSource,
          };

          const docItems = await parser(content, fileInfo, dbCachedStars);

          const newItems: Record<string, Item> = {};
          let newCount = 0;
          let totalCount = 0;
          let fileUpdatedAt = new Date(0);

          for (const docItem of docItems) {
            const itemSha1 = await sha1(docItem.rawMarkdown);
            totalCount++;

            if (items[itemSha1]) {
              newItems[itemSha1] = {
                ...items[itemSha1],
                markdown: docItem.formatedMarkdown,
                html: renderMarkdown(docItem.formatedMarkdown),
                category: docItem.category,
                category_html: renderMarkdown(docItem.category),
                checked_at: now.toISOString(),
              };
              if (new Date(items[itemSha1].updated_at) > fileUpdatedAt) {
                fileUpdatedAt = new Date(items[itemSha1].updated_at);
              }
            } else {
              newCount++;
              newItems[itemSha1] = {
                source_identifier: sourceIdentifier,
                file,
                sha1: itemSha1,
                markdown: docItem.formatedMarkdown,
                html: renderMarkdown(docItem.formatedMarkdown),
                category: docItem.category,
                category_html: renderMarkdown(docItem.category),
                updated_at: now.toISOString(),
                checked_at: now.toISOString(),
                updated_day: getDayNumber(now),
                updated_week: getWeekNumber(now),
              };
              fileUpdatedAt = now;
            }
          }

          await updateFile(fileInfo, content, dbCachedStars);
          await updateItems(fileInfo, newItems, dbIndex);

          dbFiles[file] = {
            ...dbFiles[file],
            updated_at: fileUpdatedAt.toISOString(),
            checked_at: now.toISOString(),
            sha1: contentSha1,
          };

          log.info(
            `${sourceIdentifier}/${file} updated (${newCount}/${totalCount})`,
          );

          if (totalCount < 10) {
            invalidFiles.push({
              sourceIdentifier,
              originalFilepath: file,
            });
          }

          const metaOverrides: RepoMetaOverride = {};
          if (source.default_branch) {
            metaOverrides.default_branch = source.default_branch;
          }

          const meta = await api.getRepoMeta(metaOverrides);
          dbSource.meta = meta;
          dbMeta.sources[sourceIdentifier].meta = {
            ...dbSource.meta,
            ...meta,
          };
        }

        dbMeta.sources[sourceIdentifier].files = dbFiles;
        dbMeta.sources[sourceIdentifier].updated_at =
          new Date().toISOString();

      } catch (err) {
        log.error(
          `[SKIP] Source ${sourceIdentifier} failed and was skipped`,
        );
        log.error(err instanceof Error ? err.message : String(err));

        if (dbMeta.sources[sourceIdentifier]) {
          dbMeta.sources[sourceIdentifier].updated_at =
            new Date().toISOString();
        }

        continue;
      }
    }

    await writeDbMeta(dbMeta);
    await writeDbIndex(dbIndex);
    await writeDbCachedStars(dbCachedStars);

  } catch (e) {
    await writeDbMeta(dbMeta);
    await writeDbIndex(dbIndex);
    await writeDbCachedStars(dbCachedStars);
    throw e;
  }

  if (invalidFiles.length > 0) {
    log.error(`Some files are invalid`);
    log.error(invalidFiles);
    await writeJSONFile("temp-invalid-files.json", invalidFiles);
  }
}
