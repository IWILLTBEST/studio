import React from "react";
import { observable, makeObservable } from "mobx";

import { IMessage, MessageType, PropertyType, makeDerivedClassInfo } from "project-editor/core/object";
import { getChildOfObject, Message } from "project-editor/store";

import { ProjectType } from "project-editor/project/project";

import { specificGroup } from "project-editor/ui-components/PropertyGrid/groups";

import { BAR_MODES } from "project-editor/lvgl/lvgl-constants";

import { LVGLWidget } from "./internal";
import {
    LVGLPropertyType,
    makeLvglExpressionProperty
} from "../expression-property";
import type { LVGLCode } from "project-editor/lvgl/to-lvgl-code";

////////////////////////////////////////////////////////////////////////////////

export class LVGLBarWidget extends LVGLWidget {
    min: number | string;
    minType: LVGLPropertyType;

    max: number | string;
    maxType: LVGLPropertyType;

    mode: keyof typeof BAR_MODES;
    value: number | string;
    valueType: LVGLPropertyType;
    previewValue: string;
    valueStart: number | string;
    valueStartType: LVGLPropertyType;
    previewValueStart: string;
    enableAnimation: boolean;

    static classInfo = makeDerivedClassInfo(LVGLWidget.classInfo, {
        enabledInComponentPalette: (projectType: ProjectType) =>
            projectType === ProjectType.LVGL,

        componentPaletteGroupName: "!1Visualiser",

        properties: [
            ...makeLvglExpressionProperty(
                "min",
                "integer",
                "input",
                ["literal", "expression"],
                {
                    propertyGridGroup: specificGroup
                }
            ),
            ...makeLvglExpressionProperty(
                "max",
                "integer",
                "input",
                ["literal", "expression"],
                {
                    propertyGridGroup: specificGroup
                }
            ),
            {
                name: "mode",
                type: PropertyType.Enum,
                enumItems: Object.keys(BAR_MODES).map(id => ({
                    id,
                    label: id
                })),
                enumDisallowUndefined: true,
                propertyGridGroup: specificGroup
            },
            ...makeLvglExpressionProperty(
                "value",
                "integer",
                "input",
                ["literal", "expression"],
                {
                    propertyGridGroup: specificGroup
                }
            ),
            {
                name: "previewValue",
                type: PropertyType.String,
                disabled: (widget: LVGLBarWidget) => {
                    return widget.valueType == "literal";
                },
                propertyGridGroup: specificGroup
            },
            ...makeLvglExpressionProperty(
                "valueStart",
                "integer",
                "input",
                ["literal", "expression"],
                {
                    propertyGridGroup: specificGroup,
                    disabled: (bar: LVGLBarWidget) => bar.mode != "RANGE"
                }
            ),
            {
                name: "previewValueStart",
                type: PropertyType.String,
                disabled: (widget: LVGLBarWidget) => {
                    return widget.valueStartType == "literal" || widget.mode != "RANGE";
                },
                propertyGridGroup: specificGroup
            },
            {
                name: "enableAnimation",
                type: PropertyType.Boolean,
                checkboxStyleSwitch: true,
                propertyGridGroup: specificGroup
            }
        ],

        defaultValue: {
            left: 0,
            top: 0,
            width: 150,
            height: 10,
            clickableFlag: true,
            min: 0,
            minType: "literal",
            max: 100,
            maxType: "literal",
            mode: "NORMAL",
            value: 25,
            valueType: "literal",
            previewValue: "25",
            valueStart: 0,
            valueStartType: "literal",
            previewValueStart: "0",
            enableAnimation: false
        },

        beforeLoadHook: (
            object: LVGLBarWidget,
            jsObject: Partial<LVGLBarWidget>
        ) => {
            if (jsObject.minType == undefined) {
                jsObject.minType = "literal";
            }

            if (jsObject.maxType == undefined) {
                jsObject.maxType = "literal";
            }
        },

        icon: (
            <svg viewBox="0 0 32 32" fill="currentColor">
                <path d="M28 21H4a2.0021 2.0021 0 0 1-2-2v-6a2.0021 2.0021 0 0 1 2-2h24a2.0021 2.0021 0 0 1 2 2v6a2.0021 2.0021 0 0 1-2 2ZM4 13v6h24v-6Z" />
                <path d="M6 15h14v2H6z" />
                <path fill="none" d="M0 0h32v32H0z" />
            </svg>
        ),

        check: (widget: LVGLBarWidget, messages: IMessage[]) => {
            if (widget.minType == "literal") {
                if (
                    widget.min == undefined ||
                    widget.min == null ||
                    !Number.isInteger(Number(widget.min))
                ) {
                    messages.push(
                        new Message(
                            MessageType.ERROR,
                            `Min must be an integer`,
                            getChildOfObject(widget, "min")
                        )
                    );
                }
            }

            if (widget.maxType == "literal") {
                if (
                    widget.max == undefined ||
                    widget.max == null ||
                    !Number.isInteger(Number(widget.max))
                ) {
                    messages.push(
                        new Message(
                            MessageType.ERROR,
                            `Max must be an integer`,
                            getChildOfObject(widget, "max")
                        )
                    );
                }
            }
        },

        lvgl: {
            parts: ["MAIN", "INDICATOR"],
            defaultFlags:
                "CLICKABLE|CLICK_FOCUSABLE|GESTURE_BUBBLE|PRESS_LOCK|SCROLL_CHAIN_HOR|SCROLL_CHAIN_VER|SCROLL_ELASTIC|SCROLL_MOMENTUM|SCROLL_WITH_ARROW|SNAPPABLE",

            oldInitFlags: "PRESS_LOCK|CLICK_FOCUSABLE|GESTURE_BUBBLE|SNAPPABLE",
            oldDefaultFlags:
                "PRESS_LOCK|CLICK_FOCUSABLE|GESTURE_BUBBLE|SNAPPABLE"
        }
    });

    override makeEditable() {
        super.makeEditable();

        makeObservable(this, {
            min: observable,
            minType: observable,
            max: observable,
            maxType: observable,
            mode: observable,
            value: observable,
            valueType: observable,
            previewValue: observable,
            valueStart: observable,
            valueStartType: observable,
            previewValueStart: observable,
            enableAnimation: observable
        });
    }

    override toLVGLCode(code: LVGLCode) {
        code.createObject("lv_bar_create");

        if (this.minType == "literal" && this.maxType == "literal") {
            if (this.min != 0 || this.max != 100) {
                code.callObjectFunction(
                    "lv_bar_set_range",
                    this.min,
                    this.max
                );
            }
        } else if (this.minType == "literal") {
            code.callObjectFunction("lv_bar_set_range", this.min, 100);
        } else if (this.maxType == "literal") {
            code.callObjectFunction("lv_bar_set_range", 0, this.max);
        }

        if (this.minType == "expression") {
            code.addToTick("min", () => {
                const new_val = code.evalIntegerProperty(
                    "int32_t",
                    "new_val",
                    this.min as string,
                    "Failed to evaluate Min in Bar widget"
                );

                const cur_val = code.callObjectFunctionWithAssignment(
                    "int32_t",
                    "cur_val",
                    "lv_bar_get_min_value"
                );

                code.ifNotEqual(new_val, cur_val, () => {
                    const min = code.assign("int16_t", "min", new_val);

                    const max = code.callObjectFunctionWithAssignment(
                        "int16_t",
                        "max",
                        "lv_bar_get_max_value"
                    );

                    code.ifLess(min, max, () => {
                        code.callObjectFunction(
                            "lv_bar_set_range",
                            min,
                            max
                        );
                    });
                });
            });
        }

        if (this.maxType == "expression") {
            code.addToTick("max", () => {
                const new_val = code.evalIntegerProperty(
                    "int32_t",
                    "new_val",
                    this.max as string,
                    "Failed to evaluate Max in Bar widget"
                );

                const cur_val = code.callObjectFunctionWithAssignment(
                    "int32_t",
                    "cur_val",
                    "lv_bar_get_max_value"
                );

                code.ifNotEqual(new_val, cur_val, () => {
                    const min = code.callObjectFunctionWithAssignment(
                        "int16_t",
                        "min",
                        "lv_bar_get_min_value"
                    );

                    const max = code.assign("int16_t", "max", new_val);

                    code.ifLess(min, max, () => {
                        code.callObjectFunction(
                            "lv_bar_set_range",
                            min,
                            max
                        );
                    });
                });
            });
        }

        if (this.mode != "NORMAL") {
            code.callObjectFunction(
                "lv_bar_set_mode",
                code.constant(`LV_BAR_MODE_${this.mode}`)
            );
        }

        if (this.valueType == "literal") {
            if (this.value != 0) {
                code.callObjectFunction(
                    "lv_bar_set_value",
                    this.value,
                    this.enableAnimation
                        ? code.constant("LV_ANIM_ON")
                        : code.constant("LV_ANIM_OFF")
                );
            }
        } else {
            if (code.pageRuntime && code.pageRuntime.isEditor) {
                const previewValue = Number.parseInt(this.previewValue);
                if (!isNaN(previewValue)) {
                    code.callObjectFunction(
                        "lv_bar_set_value",
                        previewValue,
                        code.constant("LV_ANIM_OFF")
                    );
                }
            }

            code.addToTick("value", () => {
                const new_val = code.evalIntegerProperty(
                    "int32_t",
                    "new_val",
                    this.value as string,
                    "Failed to evaluate Value in Bar widget"
                );

                const cur_val = code.callObjectFunctionWithAssignment(
                    "int32_t",
                    "cur_val",
                    "lv_bar_get_value"
                );

                code.ifNotEqual(new_val, cur_val, () => {
                    code.tickChangeStart();

                    code.callObjectFunction(
                        "lv_bar_set_value",
                        new_val,
                        this.enableAnimation
                            ? code.constant("LV_ANIM_ON")
                            : code.constant("LV_ANIM_OFF")
                    );

                    code.tickChangeEnd();
                });
            });
        }

        if (this.mode == "RANGE") {
            if (this.valueStartType == "literal") {
                if (this.valueType == "expression") {
                    code.callObjectFunction(
                        "lv_bar_set_value",
                        this.valueStart,
                        this.enableAnimation
                            ? code.constant("LV_ANIM_ON")
                            : code.constant("LV_ANIM_OFF")
                    );
                }

                code.callObjectFunction(
                    "lv_bar_set_start_value",
                    this.valueStart,
                    this.enableAnimation
                        ? code.constant("LV_ANIM_ON")
                        : code.constant("LV_ANIM_OFF")
                );
            } else {
                if (code.pageRuntime && code.pageRuntime.isEditor) {
                    const previewValueStart = Number.parseInt(this.previewValueStart);
                    if (!isNaN(previewValueStart)) {
                        code.callObjectFunction(
                            "lv_bar_set_start_value",
                            previewValueStart,
                            code.constant("LV_ANIM_OFF")
                        );
                    }
                }

                code.addToTick("valueStart", () => {
                    const new_val = code.evalIntegerProperty(
                        "int32_t",
                        "new_val",
                        this.value as string,
                        "Failed to evaluate Value start in Bar widget"
                    );

                    const cur_val = code.callObjectFunctionWithAssignment(
                        "int32_t",
                        "cur_val",
                        "lv_bar_get_start_value"
                    );

                    code.ifNotEqual(new_val, cur_val, () => {
                        code.tickChangeStart();

                        code.callObjectFunction(
                            "lv_bar_set_start_value",
                            new_val,
                            this.enableAnimation
                                ? code.constant("LV_ANIM_ON")
                                : code.constant("LV_ANIM_OFF")
                        );

                        code.tickChangeEnd();
                    });
                });
            }
        }
    }
}
