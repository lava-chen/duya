export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaValidationError[];
}

export interface SchemaValidationError {
  path: string;
  message: string;
  keyword?: string;
}

export function validateDataAgainstSchema(
  data: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): SchemaValidationResult {
  if (!schema) {
    return { valid: true, errors: [] };
  }

  const errors: SchemaValidationError[] = [];

  if (schema.type === "object" && schema.properties) {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const required = (schema.required as string[] | undefined) ?? [];

    for (const key of required) {
      if (!(key in data) || data[key] === undefined) {
        errors.push({
          path: `/${key}`,
          message: `Required field "${key}" is missing`,
          keyword: "required",
        });
      }
    }

    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in data && data[key] !== undefined) {
        const value = data[key];
        const expectedType = propSchema.type;

        if (expectedType === "string" && typeof value !== "string") {
          errors.push({
            path: `/${key}`,
            message: `Field "${key}" expected string, got ${typeof value}`,
            keyword: "type",
          });
        } else if (expectedType === "number" && typeof value !== "number") {
          errors.push({
            path: `/${key}`,
            message: `Field "${key}" expected number, got ${typeof value}`,
            keyword: "type",
          });
        } else if (expectedType === "boolean" && typeof value !== "boolean") {
          errors.push({
            path: `/${key}`,
            message: `Field "${key}" expected boolean, got ${typeof value}`,
            keyword: "type",
          });
        } else if (expectedType === "array" && !Array.isArray(value)) {
          errors.push({
            path: `/${key}`,
            message: `Field "${key}" expected array, got ${typeof value}`,
            keyword: "type",
          });
        } else if (expectedType === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) {
          errors.push({
            path: `/${key}`,
            message: `Field "${key}" expected object, got ${typeof value}`,
            keyword: "type",
          });
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function validateTemplateData(
  data: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): { valid: boolean; errors: string[] } {
  const result = validateDataAgainstSchema(data, schema);

  return {
    valid: result.valid,
    errors: result.errors.map((e) => `${e.path}: ${e.message}`),
  };
}
