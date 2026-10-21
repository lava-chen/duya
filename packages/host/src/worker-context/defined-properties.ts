type DefinedProperties<T extends object> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Omit absent values when constructing an external options or wire object. */
export function definedProperties<T extends object>(value: T): DefinedProperties<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as DefinedProperties<T>;
}
