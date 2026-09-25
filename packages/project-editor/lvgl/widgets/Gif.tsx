import fs from "fs";
import React from "react";
import { makeObservable, observable } from "mobx";

import {
    IMessage,
    MessageType,
    PropertyType,
    makeDerivedClassInfo
} from "project-editor/core/object";

import { findBitmap, ProjectType } from "project-editor/project/project";

import { specificGroup } from "project-editor/ui-components/PropertyGrid/groups";

import { LVGLWidget } from "./internal";
import { escapeCString } from "../widget-common";
import { ProjectEditor } from "project-editor/project-editor-interface";
import {
    getChildOfObject,
    Message,
    propertyNotFoundMessage,
    propertyNotSetMessage
} from "project-editor/store";
import type { Bitmap } from "project-editor/features/bitmap/bitmap";
import type { LVGLCode } from "project-editor/lvgl/to-lvgl-code";

////////////////////////////////////////////////////////////////////////////////

//
// The editor preview (wasm) path builds an lv_img_dsc_t in wasm memory
// pointing at the raw (undecoded) GIF file bytes. lv_gif_set_src detects
// the source type from the first byte: a bare byte array starting with
// 'G' (0x47) would be treated as a file path, so the descriptor wrapper
// is mandatory (its VARIABLE branch only reads data/data_size, see
// lv_gif.c).
//
// Layout on wasm32: header@0 (4 bytes), data@4, data_size@8.
//
// The allocation is cached per wasm instance and bitmap name and never
// freed: GIFs are small and page runtimes are rebuilt, but the wasm
// instance persists, so a changed bitmap keeps the old bytes until the
// next project reload.
//
const gifDscCache = new WeakMap<object, Map<string, number>>();

function getGifDscPtr(code: LVGLCode, bitmap: Bitmap): number {
    const simulatorCode = code as any;
    const runtime = simulatorCode.runtime;
    const wasm = runtime.wasm;

    // lv_img_dsc_t layout on wasm32 (verified against the actual
    // headers; lv_gif only reads data/data_size, the header is left
    // zeroed):
    // - LVGL 8.x: bitfield header (4 bytes), data@4, data_size@8
    // - LVGL 9.x: bitfield lv_image_header_t (12 bytes),
    //   data_size@12, data@16 (+ 2 reserved pointers)
    const dataOffset = code.isV9 ? 16 : 4;
    const sizeOffset = code.isV9 ? 12 : 8;
    const dscSize = code.isV9 ? 24 : 12;

    let perWasm = gifDscCache.get(wasm);
    if (!perWasm) {
        perWasm = new Map<string, number>();
        gifDscCache.set(wasm, perWasm);
    }

    const bitmapName = bitmap.name ?? "";
    const cached = perWasm.get(bitmapName);
    if (cached != undefined) {
        return cached;
    }

    let bytes: Uint8Array;
    const image = bitmap.image!;
    if (image.startsWith("data:")) {
        bytes = Buffer.from(
            image.substring(image.indexOf(",") + 1),
            "base64"
        );
    } else {
        bytes = fs.readFileSync(
            runtime.project._store.getAbsoluteFilePath(image)
        );
    }

    const bytesPtr = wasm._malloc(bytes.length);
    wasm.HEAPU8.set(bytes, bytesPtr);

    const dscPtr = wasm._malloc(dscSize);
    wasm.HEAPU32.fill(0, dscPtr >> 2, (dscPtr >> 2) + dscSize / 4);
    wasm.HEAPU32[(dscPtr + dataOffset) >> 2] = bytesPtr;
    wasm.HEAPU32[(dscPtr + sizeOffset) >> 2] = bytes.length;

    perWasm.set(bitmapName, dscPtr);
    return dscPtr;
}

////////////////////////////////////////////////////////////////////////////////

export class LVGLGifWidget extends LVGLWidget {
    image: string;
    fromFileSystem: boolean;
    file: string;

    static classInfo = makeDerivedClassInfo(LVGLWidget.classInfo, {
        enabledInComponentPalette: (projectType: ProjectType) =>
            projectType === ProjectType.LVGL,

        componentPaletteGroupName: "!1Basic",

        label: (widget: LVGLGifWidget) => {
            const name = "Gif";
            if (widget.image) {
                return `${name}: ${widget.image}`;
            }
            return name;
        },

        properties: [
            {
                name: "image",
                displayName: "Source",
                type: PropertyType.ObjectReference,
                referencedObjectCollectionPath: "bitmaps",
                propertyGridGroup: specificGroup,
                formText:
                    "A GIF bitmap (imported without decoding). The raw file bytes are embedded in the generated code (LV_IMG_CF_RAW descriptor) and played by lv_gif. Note: the size of the frame buffer allocated at runtime is determined by the canvas size of the GIF."
            },
            {
                name: "fromFileSystem",
                displayName: "From file system",
                type: PropertyType.Boolean,
                propertyGridGroup: specificGroup,
                checkboxStyleSwitch: true,
                formText:
                    "Instead of embedding the GIF as a byte array, the generated code references it with a file path (streamed via lv_fs, e.g. GIF_openFile) and the build copies the .gif file next to the generated sources. The path prefix comes from the build File system path setting and must match the drive letter registered by the target's lv_fs driver (e.g. S:/ for littlefs on SD, A:/ for stdio). Requires LV_USE_GIF and an lv_fs driver on the device."
            },
            {
                name: "file",
                displayName: "File",
                type: PropertyType.String,
                propertyGridGroup: specificGroup,
                hideInPropertyGrid: (widget: LVGLGifWidget) =>
                    !widget.fromFileSystem,
                formText:
                    "Optional full device path of the GIF (including the drive letter, e.g. S:/animations/hero.gif). When set, the build emits nothing for this GIF (put the file on the device yourself) and Source serves only as the editor preview stand-in - prefer a fixed pixel size when the real file's dimensions differ."
            }
        ],

        defaultValue: {
            left: 0,
            top: 0,
            width: 60,
            height: 40,
            widthUnit: "content",
            heightUnit: "content",
            image: "",
            fromFileSystem: false,
            file: ""
        },

        icon: (
            <svg viewBox="0 0 24 24">
                <path
                    d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm6 4v6l6-3-6-3z"
                    fill="currentcolor"
                />
            </svg>
        ),

        check: (widget: LVGLGifWidget, messages: IMessage[]) => {
            if (!widget.image) {
                messages.push(propertyNotSetMessage(widget, "image"));
            } else {
                const bitmap = findBitmap(
                    ProjectEditor.getProject(widget),
                    widget.image
                );

                if (!bitmap) {
                    messages.push(propertyNotFoundMessage(widget, "image"));
                } else if (!bitmap.isGif) {
                    messages.push(
                        new Message(
                            MessageType.ERROR,
                            `Bitmap is not a GIF`,
                            getChildOfObject(widget, "image")
                        )
                    );
                }
            }

            if (
                widget.fromFileSystem &&
                widget.file &&
                !/^[A-Za-z0-9]+:/.test(widget.file)
            ) {
                messages.push(
                    new Message(
                        MessageType.ERROR,
                        `File must be a full device path including the drive letter (e.g. S:/animations/hero.gif)`,
                        getChildOfObject(widget, "file")
                    )
                );
            }

            if (widget.fromFileSystem && !widget.file) {
                if (
                    !ProjectEditor.getProject(widget).settings.build
                        .fileSystemPath
                ) {
                    messages.push(
                        new Message(
                            MessageType.ERROR,
                            `File system path is not set (Build settings)`,
                            widget
                        )
                    );
                }
            }

            if (
                ProjectEditor.getProject(
                    widget
                ).settings.build.imageExportMode == "binary"
            ) {
                messages.push(
                    new Message(
                        MessageType.ERROR,
                        `GIF widget is only supported with "source" image export mode`,
                        widget
                    )
                );
            }
        },

        lvgl: {
            parts: ["MAIN"],
            defaultFlags:
                "CLICKABLE|CLICK_FOCUSABLE|GESTURE_BUBBLE|PRESS_LOCK|SCROLL_CHAIN_HOR|SCROLL_CHAIN_VER|SCROLL_ELASTIC|SCROLL_MOMENTUM|SCROLL_ON_FOCUS|SCROLL_WITH_ARROW|SNAPPABLE"
        }
    });

    override makeEditable() {
        super.makeEditable();

        makeObservable(this, {
            image: observable,
            fromFileSystem: observable,
            file: observable
        });
    }

    override toLVGLCode(code: LVGLCode) {
        const bitmap = this.image
            ? findBitmap(ProjectEditor.getProject(this), this.image)
            : undefined;

        if (code.lvglBuild) {
            code.createObject("lv_gif_create");
            if (bitmap) {
                if (this.fromFileSystem) {
                    if (this.file) {
                        // pure pointing mode: verbatim device path,
                        // nothing is emitted or copied for this GIF
                        code.callObjectFunction(
                            "lv_gif_set_src",
                            escapeCString(this.file)
                        );
                    } else {
                        // streamed from the device file system,
                        // the .gif file is copied next to the sources
                        code.callObjectFunction(
                            "lv_gif_set_src",
                            code.lvglBuild.getGifFileSystemAccessor(this.image)
                        );
                    }
                } else {
                    // embedded as a byte array descriptor
                    code.lvglBuild.markGifEmbedded(this.image);
                    code.callObjectFunction(
                        "lv_gif_set_src",
                        `&${code.lvglBuild.getImageVariableName(this.image)}`
                    );
                }
            }
        } else {
            // feature-detect: the editor wasm must be built with
            // LV_USE_GIF (upstream builds only enable it for 8.4; our
            // fork also ships a 9.4.0 build with it enabled)
            const wasm = (code as any).runtime.wasm;
            if (wasm && wasm._lv_gif_create) {
                code.createObject("lv_gif_create");
                if (bitmap?.image) {
                    const dscPtr = getGifDscPtr(code, bitmap);
                    if (dscPtr) {
                        code.callObjectFunction("lv_gif_set_src", dscPtr);
                    }
                }
            } else {
                // no lv_gif in this editor wasm: placeholder
                // (same as the Lottie widget)
                code.createObject("lv_obj_create");
            }
        }
    }
}
