import type { ErrorObject } from "ajv";
import validate from "./generated/report-validator.mjs";

/**
 * Validate a generated report against `schemas/report.schema.json`.
 *
 * The validator is precompiled at build time (see
 * `scripts/generate-validator.cjs`). Compiling it here instead would require
 * generating and evaluating source at runtime, which constrained runtimes
 * refuse — and the monitor runs the analyzer in one.
 */
export async function validateReport(report: unknown): Promise<void> {
  if (!validate(report)) {
    throw new ReportValidationError(validate.errors ?? []);
  }
}

export class ReportValidationError extends Error {
  constructor(errors: ErrorObject[]) {
    super(`Generated report does not conform to its schema: ${JSON.stringify(errors)}`);
    this.name = "ReportValidationError";
  }
}
