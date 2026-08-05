import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ErrorObject, ValidateFunction } from "ajv";

let validator: Promise<ValidateFunction> | undefined;

export async function validateReport(report: unknown): Promise<void> {
  const validate = await getValidator();
  if (!validate(report)) {
    throw new ReportValidationError(validate.errors ?? []);
  }
}

async function getValidator(): Promise<ValidateFunction> {
  validator ??= loadValidator();
  return validator;
}

async function loadValidator(): Promise<ValidateFunction> {
  const schemaUrl = new URL("../../schemas/report.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(fileURLToPath(schemaUrl), "utf8")) as object;
  const [ajvModule, formatsModule] = await Promise.all([import("ajv/dist/2020.js"), import("ajv-formats")]);
  const AjvConstructor = (ajvModule.default ?? ajvModule) as unknown as new (options: JsonSchemaOptions) => JsonSchemaValidator;
  const addFormats = (formatsModule.default ?? formatsModule) as unknown as (validator: JsonSchemaValidator) => void;
  const ajv = new AjvConstructor({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

interface JsonSchemaOptions {
  allErrors: boolean;
  strict: boolean;
}

interface JsonSchemaValidator {
  compile(schema: object): ValidateFunction;
}

export class ReportValidationError extends Error {
  constructor(errors: ErrorObject[]) {
    super(`Generated report does not conform to its schema: ${JSON.stringify(errors)}`);
    this.name = "ReportValidationError";
  }
}
