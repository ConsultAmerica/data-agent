"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

type DocumentChromeValue = {
  documentTitle: string | null;
  setDocumentTitle: (title: string | null) => void;
};

const DocumentChromeContext = createContext<DocumentChromeValue>({
  documentTitle: null,
  setDocumentTitle: () => undefined,
});

export function DocumentChromeProvider({ children }: { children: ReactNode }) {
  const [documentTitle, setDocumentTitle] = useState<string | null>(null);
  const value = useMemo(() => ({ documentTitle, setDocumentTitle }), [documentTitle]);
  return <DocumentChromeContext.Provider value={value}>{children}</DocumentChromeContext.Provider>;
}

export function useDocumentChrome() {
  return useContext(DocumentChromeContext);
}
