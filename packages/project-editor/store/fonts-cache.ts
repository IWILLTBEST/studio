import fs from "fs";

import * as notification from "eez-studio-ui/notification";

import type { ProjectStore } from "project-editor/store";
import { isScrapbookItemFilePath } from "project-editor/store/scrapbook";

import type { ExtractFontParams } from "project-editor/features/font/font-extract";

////////////////////////////////////////////////////////////////////////////////

interface FontsCacheEntry {
    extractFontParams: ExtractFontParams;
    binFile: string;
    sourceFile: string;
}

export class FontsCacheStore {
    fontsCache: FontsCacheEntry[] = [];

    constructor(public projectStore: ProjectStore) {}

    getFontsCacheFilePath() {
        if (
            this.projectStore.filePath &&
            !isScrapbookItemFilePath(this.projectStore.filePath)
        ) {
            return this.projectStore.filePath + "-fonts-cache";
        }
        return undefined;
    }

    async load() {
        let fontsCache: FontsCacheEntry[] | undefined = undefined;

        if (this.projectStore.project.settings.general.cacheFonts) {
            const filePath = this.getFontsCacheFilePath();
            if (filePath) {
                try {
                    const data = await fs.promises.readFile(filePath, "utf8");
                    try {
                        fontsCache = JSON.parse(data);
                    } catch (err) {
                        console.error(err);
                    }
                } catch (err) {}
            }
        }

        if (!fontsCache) {
            fontsCache = [];
        }

        this.fontsCache = fontsCache;
    }

    async save() {
        const filePath = this.getFontsCacheFilePath();
        if (!filePath) {
            return;
        }

        if (this.projectStore.project.settings.general.cacheFonts) {
            let fontsCache: any;

            for (const font of this.projectStore.project.fonts) {
                if (
                    font._lvglFontDefinitionExtractFontParams &&
                    font._lvglFontDefinition
                ) {
                    if (!fontsCache) {
                        fontsCache = [];
                    }
                    fontsCache.push({
                        extractFontParams:
                            font._lvglFontDefinitionExtractFontParams,
                        binFile: font._lvglFontDefinition.binFile,
                        sourceFile: font._lvglFontDefinition.sourceFile
                    });
                }
            }

            try {
                await fs.promises.writeFile(
                    filePath,
                    JSON.stringify(fontsCache, undefined, 2),
                    "utf8"
                );
            } catch (err) {
                notification.error("Failed to create fonts cache file: " + err);
            }
        } else {
            try {
                if (fs.existsSync(filePath)) {
                    try {
                        await fs.promises.unlink(filePath);
                    } catch (err) {
                        notification.error(
                            "Failed to delete fonts cache file: " + err
                        );
                    }
                }
            } catch (err) {
                console.error(err);
            }
        }
    }

    getCachedFontDefinition(extractFontParams: ExtractFontParams) {
        for (const fontCacheEntry of this.fontsCache) {
            if (
                JSON.stringify(fontCacheEntry.extractFontParams) ==
                JSON.stringify(extractFontParams)
            ) {
                return {
                    lvglBinFile: fontCacheEntry.binFile,
                    lvglSourceFile: fontCacheEntry.sourceFile
                };
            }
        }
        return undefined;
    }
}
