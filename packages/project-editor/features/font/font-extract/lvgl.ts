import type {
    ExtractFontParams,
    FontProperties,
    GlyphProperties,
    IFontExtract
} from "project-editor/features/font/font-extract";

import fs from "fs";
import path from "path";
import { getName, NamingConvention } from "project-editor/build/helper";
import * as notification from "eez-studio-ui/notification";

let extractBusy = false;

export class ExtractFont implements IFontExtract {
    fontProperties: FontProperties;
    allEncodings: number[];
    fontData: any;

    constructor(private params: ExtractFontParams) {}

    async start() {
        let source_bin = this.params.embeddedFontFile
            ? Buffer.from(this.params.embeddedFontFile, "base64")
            : fs.readFileSync(this.params.absoluteFilePath);

        const range: number[] = [];
        this.params.encodings!.map(encodingRange =>
            range.push(
                encodingRange.from,
                encodingRange.to,
                encodingRange.mapped_from ?? encodingRange.from
            )
        );

        const symbols = this.params.symbols ?? "";

        const font: any[] = [
            {
                source_path: this.params.absoluteFilePath,
                source_bin_base64: source_bin.toString("base64"),
                ranges: [
                    {
                        range,
                        symbols
                    }
                ]
            }
        ];

        if (this.params.additionalSources) {
            for (const additionalSource of this.params.additionalSources) {
                const addSourceBin = additionalSource.embeddedFontFile
                    ? Buffer.from(additionalSource.embeddedFontFile, "base64")
                    : fs.readFileSync(additionalSource.absoluteFilePath);

                const addRange: number[] = [];
                if (additionalSource.encodings) {
                    additionalSource.encodings.map(encodingRange =>
                        addRange.push(
                            encodingRange.from,
                            encodingRange.to,
                            encodingRange.mapped_from ?? encodingRange.from
                        )
                    );
                }

                const addSymbols = additionalSource.symbols ?? "";

                font.push({
                    source_path: additionalSource.absoluteFilePath,
                    source_bin_base64: addSourceBin.toString("base64"),
                    ranges: [
                        {
                            range: addRange,
                            symbols: addSymbols
                        }
                    ]
                });
            }
        }

        const output = getName(
            "ui_font_",
            this.params.name || "",
            NamingConvention.UnderscoreLowerCase
        );

        const args = {
            font,
            size: this.params.size,
            bpp: this.params.bpp,
            no_compress: true,
            lcd: false,
            lcd_v: false,
            use_color_info: false,
            output,
            lv_include: this.params.lvglInclude,
            no_kerning: false,
            no_prefilter: false,
            fast_kerning: false,
            opts_string: this.params.opts_string,
            lv_fallback: this.params.lv_fallback
                ? this.params.lv_fallback
                : undefined,
            // stride: 1,
            // align: 1,
            // no_kerning: true
        };

        // wait for !extractBusy
        await new Promise<void>(resolve => {
            const interval = setInterval(() => {
                if (!extractBusy) {
                    clearInterval(interval);
                    resolve();
                }
            }, 10);
        });

        extractBusy = true;

        const fontName = this.params.name || "font";

        // show notification only if this takes longer than 1 second
        const NOTIFICATION_TIMEOUT = 3000;
        let toastId;
        function createToast() {
            toastId = notification.info(
                `Extracting font "${fontName}"...`,
                { autoClose: false, isLoading: true }
            );
        }
        let timeout: any = setTimeout(() => {
            timeout = undefined;
            createToast();
        }, NOTIFICATION_TIMEOUT);
        //

        try {
            const workerResult = await new Promise<any>((resolve, reject) => {
                const workerPath = path.join(
                    __dirname,
                    "lvgl-worker.js"
                );
                const worker = new Worker(workerPath);

                worker.onmessage = (e: MessageEvent) => {
                    worker.terminate();
                    if (e.data.error) {
                        reject(new Error(e.data.error));
                    } else {
                        resolve(e.data);
                    }
                };

                worker.onerror = (e: ErrorEvent) => {
                    worker.terminate();
                    reject(new Error(e.message));
                };

                worker.postMessage({ args, output });
            });

            this.fontData = workerResult.fontData;
            const lvglBinFile = workerResult.lvglBinFile;
            const lvglSourceFile = workerResult.lvglSourceFile;

            this.fontProperties = {
                name: this.params.name || "",
                renderingEngine: "LVGL",
                source: {
                    filePath: this.params.relativeFilePath,
                    size: this.params.size,
                    threshold: this.params.threshold
                },
                embeddedFontFile: source_bin.toString("base64"),
                bpp: this.params.bpp,
                threshold: this.params.threshold,
                height: this.fontData.ascent - this.fontData.descent,
                ascent: this.fontData.ascent,
                descent: -this.fontData.descent,
                glyphs: [],
                lvglGlyphs: {
                    encodings: this.params.encodings!,
                    symbols
                },
                lvglBinFile,
                lvglSourceFile
            };

            if (timeout) {
                clearTimeout(timeout);
                timeout = undefined;                
            }

            if (toastId) {
                notification.update(toastId!, {
                    render: `Font "${fontName}" extracted successfully.`,
                    type: notification.SUCCESS,
                    isLoading: false,
                    autoClose: 1000
                });
            }
        } catch (err: any) {
            if (timeout) {
                clearTimeout(timeout);
                timeout = undefined;
            }

            if (!toastId) {
                // always show notification if it fails
                createToast();
            }

            notification.update(toastId!, {
                render: `Font "${fontName}" extraction failed: ${err.message}`,
                type: notification.ERROR,
                isLoading: false,
                autoClose: false
            });
            throw err;
        } finally {
            extractBusy = false;
        }
    }

    getAllGlyphs = () => {
        return this.fontData.glyphs.map((glyph: any) => {
            let glyphProperties: GlyphProperties = {} as any;

            glyphProperties.encoding = glyph.code;

            glyphProperties.dx = glyph.advanceWidth;

            glyphProperties.x = glyph.bbox.x;
            glyphProperties.y = glyph.bbox.y;
            glyphProperties.width = glyph.bbox.width;
            glyphProperties.height = glyph.bbox.height;

            glyphProperties.source = {
                filePath: this.params.relativeFilePath,
                size: this.params.size,
                threshold: this.params.threshold,
                encoding: glyph.code
            } as any;

            const pixelArray: number[] = [];
            for (const row of glyph.pixels) {
                pixelArray.push(...row);
            }

            glyphProperties.glyphBitmap = {
                width: glyph.bbox.width,
                height: glyph.bbox.height,
                pixelArray
            };

            return glyphProperties;
        });
    };

    freeResources() {
        extractBusy = false;
    }
}
