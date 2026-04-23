import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { IntlProvider as ReactIntlProvider } from "react-intl";
import {
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  type Locale,
  messagesFor,
  SUPPORTED_LOCALES,
} from "./messages";

function negotiateLocale(): Locale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  for (const candidate of navigator.languages ?? [navigator.language]) {
    if (!candidate) continue;
    const exact = SUPPORTED_LOCALES.find((l) => l === candidate);
    if (exact) return exact;
    const lang = candidate.split("-")[0];
    const partial = SUPPORTED_LOCALES.find((l) => l.startsWith(`${lang}-`) || l === lang);
    if (partial) return partial;
  }
  return DEFAULT_LOCALE;
}

export function IntlProvider({
  children,
  locale: forcedLocale,
}: {
  children: ReactNode;
  locale?: Locale;
}) {
  const [locale] = useState<Locale>(() => forcedLocale ?? negotiateLocale());
  const messages = useMemo(() => messagesFor(locale), [locale]);
  return (
    <ReactIntlProvider
      locale={locale}
      defaultLocale={FALLBACK_LOCALE}
      messages={messages}
    >
      {children}
    </ReactIntlProvider>
  );
}
