import * as URI from "urijs";
import { OrderedMap, OrderedSet, List, Set } from "immutable";

import {
    Ref,
    checkJSONSchema,
    refsInSchemaForURI,
    addTypesInSchema,
    JSONSchemaAttributeProducer
} from "./JSONSchemaInput";
import { Value, CompressedJSON } from "./CompressedJSON";
import { JSONSchemaStore, JSONSchema } from "./JSONSchemaStore";
import {
    parseJSON,
    panic,
    assert,
    forEachSync,
    defined,
    withDefault,
    errorMessage,
    toString,
    toReadable,
    StringInput
} from "../support/Support";
import { messageError } from "../Messages";
import { TypeBuilder } from "../TypeBuilder";
import { makeNamesTypeAttributes } from "../TypeNames";
import { descriptionTypeAttributeKind, descriptionAttributeProducer } from "../Description";
import { TypeInference } from "./Inference";
import { TargetLanguage } from "../TargetLanguage";
import { languageNamed } from "../language/All";
import { accessorNamesAttributeProducer } from "../AccessorNames";

class InputJSONSchemaStore extends JSONSchemaStore {
    constructor(private readonly _inputs: Map<string, StringInput>, private readonly _delegate?: JSONSchemaStore) {
        super();
    }

    async fetch(address: string): Promise<JSONSchema | undefined> {
        const maybeInput = this._inputs.get(address);
        if (maybeInput !== undefined) {
            return checkJSONSchema(parseJSON(await toString(maybeInput), "JSON Schema", address), () =>
                Ref.root(address)
            );
        }
        if (this._delegate === undefined) {
            return panic(`Schema URI ${address} requested, but no store given`);
        }
        return await this._delegate.fetch(address);
    }
}

export interface Input<T> {
    readonly kind: string;
    readonly needIR: boolean;
    readonly needSchemaProcessing: boolean;

    addSource(source: T): Promise<void>;

    finishAddingInputs(): void;

    singleStringSchemaSource(): string | undefined;

    addTypes(
        typeBuilder: TypeBuilder,
        inferEnums: boolean,
        inferDates: boolean,
        fixedTopLevels: boolean
    ): Promise<void>;
}

type JSONTopLevel = { samples: Value[]; description: string | undefined };

export interface JSONSourceData {
    name: string;
    samples: StringInput[];
    description?: string;
}

export class JSONInput implements Input<JSONSourceData> {
    readonly kind: string = "json";
    readonly needIR: boolean = true;
    readonly needSchemaProcessing: boolean = false;

    private _topLevels: OrderedMap<string, JSONTopLevel> = OrderedMap();

    /* tslint:disable:no-unused-variable */
    constructor(private readonly _compressedJSON: CompressedJSON) {}

    private addSample(topLevelName: string, sample: Value): void {
        let topLevel = this._topLevels.get(topLevelName);
        if (topLevel === undefined) {
            topLevel = { samples: [], description: undefined };
            this._topLevels = this._topLevels.set(topLevelName, topLevel);
        }
        topLevel.samples.push(sample);
    }

    private setDescription(topLevelName: string, description: string): void {
        let topLevel = this._topLevels.get(topLevelName);
        if (topLevel === undefined) {
            return panic("Trying to set description for a top-level that doesn't exist");
        }
        topLevel.description = description;
    }

    async addSource(source: JSONSourceData): Promise<void> {
        const { name, samples, description } = source;
        for (const sample of samples) {
            let value: Value;
            try {
                value = await this._compressedJSON.readFromStream(toReadable(sample));
            } catch (e) {
                return messageError("MiscJSONParseError", {
                    description: withDefault(description, "input"),
                    address: name,
                    message: errorMessage(e)
                });
            }
            this.addSample(name, value);
            if (description !== undefined) {
                this.setDescription(name, description);
            }
        }
    }

    async finishAddingInputs(): Promise<void> {
        return;
    }

    singleStringSchemaSource(): undefined {
        return undefined;
    }

    async addTypes(
        typeBuilder: TypeBuilder,
        inferEnums: boolean,
        inferDates: boolean,
        fixedTopLevels: boolean
    ): Promise<void> {
        const inference = new TypeInference(typeBuilder, inferEnums, inferDates);

        this._topLevels.forEach(({ samples, description }, name) => {
            const tref = inference.inferType(
                this._compressedJSON,
                makeNamesTypeAttributes(name, false),
                samples,
                fixedTopLevels
            );
            typeBuilder.addTopLevel(name, tref);
            if (description !== undefined) {
                const attributes = descriptionTypeAttributeKind.makeAttributes(OrderedSet([description]));
                typeBuilder.addAttributes(tref, attributes);
            }
        });
    }
}

export function jsonInputForTargetLanguage(
    targetLanguage: string | TargetLanguage,
    languages?: TargetLanguage[]
): JSONInput {
    let lang: TargetLanguage;
    if (typeof targetLanguage === "string") {
        const maybeLang = languageNamed(targetLanguage, languages);
        if (maybeLang === undefined) {
            return messageError("DriverUnknownOutputLanguage", { lang: targetLanguage });
        }
        lang = maybeLang;
    } else {
        lang = targetLanguage;
    }

    const mapping = lang.stringTypeMapping;
    const makeDate = mapping.date !== "string";
    const makeTime = mapping.time !== "string";
    const makeDateTime = mapping.dateTime !== "string";

    const compressedJSON = new CompressedJSON(makeDate, makeTime, makeDateTime);

    return new JSONInput(compressedJSON);
}

export interface JSONSchemaSourceData {
    name: string;
    uris?: string[];
    schema?: StringInput;
    isConverted?: boolean;
}

export class JSONSchemaInput implements Input<JSONSchemaSourceData> {
    readonly kind: string = "schema";
    readonly needSchemaProcessing: boolean = true;

    private _schemaStore: JSONSchemaStore | undefined = undefined;
    private readonly _attributeProducers: JSONSchemaAttributeProducer[];

    private readonly _schemaInputs: Map<string, StringInput> = new Map();
    private _schemaSources: List<[uri.URI, JSONSchemaSourceData]> = List();

    private _topLevels: OrderedMap<string, Ref> = OrderedMap();

    private _needIR: boolean = false;

    constructor(
        givenSchemaStore: JSONSchemaStore | undefined,
        additionalAttributeProducers: JSONSchemaAttributeProducer[] = []
    ) {
        this._schemaStore = givenSchemaStore;
        this._attributeProducers = [descriptionAttributeProducer, accessorNamesAttributeProducer].concat(
            additionalAttributeProducers
        );
    }

    get needIR(): boolean {
        return this._needIR;
    }

    addTopLevel(name: string, ref: Ref): void {
        this._topLevels = this._topLevels.set(name, ref);
    }

    async addTypes(typeBuilder: TypeBuilder): Promise<void> {
        await addTypesInSchema(typeBuilder, defined(this._schemaStore), this._topLevels, this._attributeProducers);
    }

    async addSource(schemaSource: JSONSchemaSourceData): Promise<void> {
        const { uris, schema, isConverted } = schemaSource;

        if (isConverted !== true) {
            this._needIR = true;
        }

        let normalizedURIs: uri.URI[];
        const uriPath = `-${this._schemaInputs.size + 1}`;
        if (uris === undefined) {
            normalizedURIs = [new URI(uriPath)];
        } else {
            normalizedURIs = uris.map(uri => {
                const normalizedURI = new URI(uri).normalize();
                if (
                    normalizedURI
                        .clone()
                        .hash("")
                        .toString() === ""
                ) {
                    normalizedURI.path(uriPath);
                }
                return normalizedURI;
            });
        }

        if (schema === undefined) {
            assert(uris !== undefined, "URIs must be given if schema source is not specified");
        } else {
            for (const normalizedURI of normalizedURIs) {
                this._schemaInputs.set(
                    normalizedURI
                        .clone()
                        .hash("")
                        .toString(),
                    schema
                );
            }
        }

        for (const normalizedURI of normalizedURIs) {
            this._schemaSources = this._schemaSources.push([normalizedURI, schemaSource]);
        }
    }

    async finishAddingInputs(): Promise<void> {
        if (this._schemaSources.isEmpty()) return;

        let maybeSchemaStore = this._schemaStore;
        if (this._schemaInputs.size === 0) {
            if (maybeSchemaStore === undefined) {
                return panic("Must have a schema store to process JSON Schema");
            }
        } else {
            maybeSchemaStore = this._schemaStore = new InputJSONSchemaStore(this._schemaInputs, maybeSchemaStore);
        }
        const schemaStore = maybeSchemaStore;

        await forEachSync(this._schemaSources, async ([normalizedURI, source]) => {
            const givenName = source.name;

            const refs = await refsInSchemaForURI(schemaStore, normalizedURI, givenName);
            if (Array.isArray(refs)) {
                let name: string;
                if (this._schemaSources.size === 1) {
                    name = givenName;
                } else {
                    name = refs[0];
                }
                this.addTopLevel(name, refs[1]);
            } else {
                refs.forEach((ref, refName) => {
                    this.addTopLevel(refName, ref);
                });
            }
        });
    }

    singleStringSchemaSource(): string | undefined {
        if (!this._schemaSources.every(([_, { schema }]) => typeof schema === "string")) {
            return undefined;
        }
        const set = Set(this._schemaSources.map(([_, { schema }]) => schema as string));
        if (set.size === 1) {
            return defined(set.first());
        }
        return undefined;
    }
}

export class InputData {
    // We're comparing for identity in this OrderedSet, i.e.,
    // we do each input exactly once.
    // FIXME: Make into an OrderedMap, indexed by kind.
    private _inputs: OrderedSet<Input<any>> = OrderedSet();

    addInput<T>(input: Input<T>): void {
        this._inputs = this._inputs.add(input);
    }

    async addSource<T>(kind: string, source: T, makeInput: () => Input<T>): Promise<void> {
        let input: Input<T> | undefined = this._inputs.find(i => i.kind === kind);
        if (input === undefined) {
            input = makeInput();
            this.addInput(input);
        }
        await input.addSource(source);
    }

    async finishAddingInputs(): Promise<void> {
        await forEachSync(this._inputs, async input => {
            await input.finishAddingInputs();
        });
    }

    async addTypes(
        typeBuilder: TypeBuilder,
        inferEnums: boolean,
        inferDates: boolean,
        fixedTopLevels: boolean
    ): Promise<void> {
        await forEachSync(this._inputs, async input => {
            await input.addTypes(typeBuilder, inferEnums, inferDates, fixedTopLevels);
        });
    }

    get needIR(): boolean {
        return this._inputs.some(i => i.needIR);
    }

    get needSchemaProcessing(): boolean {
        return this._inputs.some(i => i.needSchemaProcessing);
    }

    singleStringSchemaSource(): string | undefined {
        const schemaStrings = this._inputs.map(i => i.singleStringSchemaSource()).filter(s => s !== undefined);
        if (schemaStrings.size > 1) {
            return panic("We have more than one input with a string schema source");
        }
        return schemaStrings.first();
    }
}
