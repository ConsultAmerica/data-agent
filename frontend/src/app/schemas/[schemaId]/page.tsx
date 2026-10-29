"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";

import SchemaDesigner from "@/components/schemas/schema-designer";

export default function SchemaDesignerPage() {
  const params = useParams<{ schemaId: string }>();
  return (
    <Suspense fallback={null}>
      <SchemaDesigner schemaId={Number(params.schemaId)} />
    </Suspense>
  );
}
