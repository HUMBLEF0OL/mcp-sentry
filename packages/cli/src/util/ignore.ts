import ignoreFactory, { type Ignore } from 'ignore';

/**
 * The `ignore` package ships as a CJS module whose default export is the
 * factory function. Under NodeNext the default import resolves to the
 * namespace, so we coerce once here and re-export a typed factory.
 */
type IgnoreFactory = () => Ignore;

export const createIgnore: IgnoreFactory = ignoreFactory as unknown as IgnoreFactory;

export type { Ignore };
