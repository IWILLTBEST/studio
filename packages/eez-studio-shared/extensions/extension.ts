import type { UNITS } from "eez-studio-shared/units";
import type { IStore } from "eez-studio-shared/store";

import type { IActivityLogEntry } from "instrument/window/history/activity-log-interfaces";

import type { IShortcut } from "shortcuts/interfaces";

import type { IFieldProperties } from "eez-studio-ui/generic-dialog";
export type { IFieldProperties } from "eez-studio-ui/generic-dialog";

import type { IEezFlowEditor } from "eez-studio-types";
import type { IHomeTab } from "home/tabs-store";

export interface IEditor {
    onCreate(): void;
    onActivate(): void;
    onDeactivate(): void;
    onTerminate(): void;
    onBeforeAppClose(): Promise<boolean>;

    render(): JSX.Element;
}

export interface IDashboard {
    title: string;
    icon: string;
}

export interface IExtensionProperties {
    properties?: any;
    shortcuts?: IShortcut[];
    moreDescription?: string;
    dashboards?: IDashboard[];
}

export type HomeTabCategory = "none" | "common" | "instrument";

export interface IHomeSection {
    id: string;
    name?: string;
    title: string;
    icon: string;
    category: HomeTabCategory;
    renderContent: () => JSX.Element;
    selectItem?: (itemId: string) => void;
}

export interface IActivityLogController {
    store: IStore;
    selection: IActivityLogEntry[];
}

interface IActivityLogTool1 {
    id: string;
    name?: string;
    title: string;
    icon: string;
    isEnabled: (controller: IActivityLogController) => boolean;
    handler: (controller: IActivityLogController) => void;
}

type IActivityLogTool2 = (
    controller: IActivityLogController
) => JSX.Element | null;

type IActivityLogTool = IActivityLogTool1 | IActivityLogTool2;

export type IMeasurementFunctionResultType = "value" | "chart";

export interface IMeasurementFunction {
    id: string;
    name: string;
    script: string;

    // On how much channels function operates?
    // Usually only 1, but some functions like add or sub operates on 2.
    // Default value is 1.
    arity?: number;

    parametersDescription?: IFieldProperties[];

    resultType?: IMeasurementFunctionResultType;
}

export interface IChart {
    data: number[];
    samplingRate: number;
    xAxes: {
        unit: keyof typeof UNITS;
        logarithmic?: boolean;
    };
    yAxes: {
        minValue?: number;
        maxValue?: number;
        unit: keyof typeof UNITS;
    };
}

interface IInput {
    // no. of samples per second
    samplingRate: number;
    getSampleValueAtIndex(index: number): number;
    valueUnit: keyof typeof UNITS;
    values: any;
}

export interface IMeasureTask extends IInput {
    // x value of the first sample (at xStartIndex)
    xStartValue: number;
    // index of the first sample to use for measurement
    xStartIndex: number;
    // total number of samples to use for measurement
    xNumSamples: number;

    // inputs in case when arity is > 1
    inputs: IInput[];

    parameters?: any;

    // store measurement result to this property
    result: number | string | IChart | null;

    resultUnit?: keyof typeof UNITS;
}

export type CommandsProtocolType = "SCPI" | "PROPRIETARY";
export type CommandLineEnding =
    | "no-line-ending"
    | "newline"
    | "carriage-return"
    | "both-nl-and-cr";

export interface IExtensionDescription {
    id: string;
    name: string;
    displayName?: string;
    version: string;
    author: string;
    description?: string;
    moreDescription?: string;
    image?: string;
    download?: string;
    sha256?: string;
    installationFolderPath?: string;
    shortName?: string;
    revisionNumber?: string;
    supportedModels?: string;
    revisionComments?: string;
    commandsProtocol: CommandsProtocolType;
    commandLineEnding: CommandLineEnding;
}

export interface IExtensionHost {
    activeTab: IHomeTab;
}

/**
 * One entry of the open-projects list (see IExtensionApi.getOpenProjects).
 */
export interface IOpenProjectInfo {
    /** File base name of the .eez-project file. */
    name: string;
    /** Absolute path of the .eez-project file. */
    filePath: string | undefined;
    /** Whether this project's editor tab is the currently selected one. */
    active: boolean;
}

/**
 * API object passed to IExtensionDefinition.init. Only the field matching
 * the current process is populated — `main` when initializing in the main
 * process, `renderer` when initializing in the renderer process — so an
 * extension can tell which process it's running in by checking which of
 * the two is present.
 */
export interface IExtensionApi {
    main?: {
        /**
         * API calls available to the extension when running inside the main process.
         */
    };

    renderer?: {
        /**
         * API calls available to the extension when running inside the renderer process.
         */

        /**
         * Require a third-party module (e.g. "mobx") by name, for
         * runtime-loaded extensions which cannot resolve node packages through
         * node module resolution. Only modules explicitly registered by the host
         * via setExtensionApiModules are available; anything else throws.
         * Studio-own modules are NOT exposed this way — they don't have a stable
         * API; the parts extensions need are exported as explicit members below
         * instead, so each addition is visible and reviewed.
         */
        requireModule?(name: string): any;

        /**
         * The list of open projects, one entry per project editor
         * tab. Best-effort export: it tracks Studio internals and may change
         * between releases — extensions should feature-detect.
         */
        getOpenProjects?(): IOpenProjectInfo[];

        /**
         * The ProjectStore of the currently selected project
         * editor tab, or undefined when no project editor is open. Best-effort
         * export: it tracks Studio internals (project-editor/store) and may
         * change between releases — extensions should feature-detect.
         */
        getActiveProjectStore?(): any;
    }
}

export type ExtensionType =
    | "built-in"
    | "iext"
    | "pext"
    | "measurement-functions";

export interface IExtensionDefinition {
    preInstalled: boolean;
    extensionType: ExtensionType;

    /**
     * Called when the extension is registered, in both the main process
     * (main/setup.ts) and the renderer process (home/main.tsx). Extensions
     * that need to hook both processes can read `api.fromProcess` to tell
     * which one is initializing (e.g. start a local server in main, register
     * IPC handlers in renderer). Extensions that don't use the parameter are
     * unaffected. The API surface is expected to grow — see issue #1042.
     */
    init?: (api: IExtensionApi) => void;
    destroy?: () => void;

    loadExtension?: (
        extensionFolderPath: string
    ) => Promise<IExtension | undefined>;
    renderPropertiesComponent?: () => React.ReactNode;
    properties?: IExtensionProperties;
    isEditable?: boolean;
    isDirty?: boolean;

    homeSections?: IHomeSection[];

    activityLogTools?: IActivityLogTool[];

    measurementFunctions?: IMeasurementFunction[];

    eezFlowExtensionInit?: (eezStudio: IEezFlowEditor) => void;

    handleDragAndDropFile?(
        filePath: string,
        host: IExtensionHost
    ): Promise<boolean>;
}

export type IExtension = IExtensionDescription & IExtensionDefinition;
