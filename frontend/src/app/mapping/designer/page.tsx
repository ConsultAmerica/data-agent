"use client";

import { Suspense } from "react";

import MappingDesigner from "@/components/mapping/mapping-designer";

export default function MappingDesignerPage() {
  return (
    <Suspense fallback={null}>
      <MappingDesigner />
    </Suspense>
  );
}
