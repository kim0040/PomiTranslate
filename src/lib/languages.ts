/** Target languages offered in a select, written in their own language. The stored value is this text. */
export const LANGUAGES: readonly string[] = [
  '한국어', 'English', '日本語', '简体中文', '繁體中文', 'Español', 'Français', 'Deutsch', 'Italiano',
  'Português (Brasil)', 'Русский', 'Polski', 'Türkçe', 'Tiếng Việt', 'ไทย', 'Bahasa Indonesia', 'العربية'
];

/** The select value that reveals the free-text field. */
export const CUSTOM_LANGUAGE = '__custom__';

/** Which select option a stored value belongs to. Anything not in the list is a custom value. */
export function languageChoice(stored: string): string {
  return LANGUAGES.includes(stored) ? stored : CUSTOM_LANGUAGE;
}
