import { createRequire } from 'node:module';

interface Translator { locale: string; t: (key: string, values?: unknown[]) => string; th: (key: string, values?: unknown[]) => string }
const i18n = createRequire(import.meta.url)('./app/shell/i18n.cjs') as {
  codes: string[];
  normalize: (locale?: string) => string;
  create: (locale?: string) => Translator;
};
export const languageCodes = i18n.codes;
export const normalizeLanguage = i18n.normalize;
export const createTranslator = i18n.create;
