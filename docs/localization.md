# Interface languages

Waymark defaults to English. It also supports Simplified Chinese (`zh-CN`), Japanese (`ja`), Korean (`ko`), Spanish (`es`), French (`fr`), German (`de`) and Portuguese (`pt`).

Select **Settings → Language** in the desktop app. The start page and audit page have the same selector. Waymark saves `uiLanguage` in the configured local settings file. The shell and local pages reload to apply a change; external website tabs are not reloaded or translated. The choice survives an app restart.

Localization covers navigation, settings, activity descriptions, challenge controls, audit pages, native context menus and displayed dates. Website content, custom shortcut names, user input, raw snapshots and audit payloads remain unchanged. CLI commands, diagnostics and MCP identifiers remain in English.

## Maintain translations

`src/app/shell/translations.cjs` is the shared message catalog. Each row contains the Chinese source message followed by English, Japanese, Korean, Spanish, French, German and Portuguese. Preserve numbered placeholders such as `{0}` in every translation. English is the fallback for unsupported locales.

- Use `t(message, values)` for text and native menus.
- Use `th(message, values)` when inserting translated text into HTML. It escapes the result.
- Static first-party page labels are translated once, before live data is rendered. Do not apply this pass to website content or audit payloads.
- Use the active locale for date formatting. Keep API values and stored records language-neutral.
- Run `npm test` for catalog completeness, placeholders, fallback and label behavior. Run `npm run test:i18n` for actual Electron language switching and restart persistence. On headless Linux, install `xvfb`, `scrot` and CJK fonts, then use `xvfb-run -a -s '-screen 0 1600x1200x24' npm run test:i18n`. Native screenshots include the embedded page views.

The English README screenshots come from the running Electron app with the bundled local demonstration fixtures. They are stored in `docs/images/en/`; the existing Chinese screenshots remain in `docs/images/`.
