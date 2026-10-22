import { getChildRelationships, getDocumentHierarchy } from "@/lib/documents";
import type { HierarchyNode } from "@/types/document";

/**
 * Documents related to one document through the persisted parent/child
 * links (base award → modifications / task orders): its parent, its
 * siblings under that parent, and its own children. Feeds the workspace's
 * quick switcher.
 */

export type RelatedRole = "parent" | "sibling" | "child";

export interface RelatedDocument {
  documentId: string;
  title: string;
  documentNumber: string | null;
  /** How this document relates to its own parent ("modification", …). */
  relationshipType: string | null;
  relationshipStatus: string | null;
  role: RelatedRole;
}

function fromNode(node: HierarchyNode, role: RelatedRole): RelatedDocument {
  return {
    documentId: node.document_id,
    title: node.title,
    documentNumber: node.document_number,
    relationshipType: node.relationship_type,
    relationshipStatus: node.relationship_status,
    role,
  };
}

/** Parent, siblings and children of `documentId` in the hierarchy forest. */
export function relatedFromHierarchy(roots: HierarchyNode[], documentId: string): RelatedDocument[] {
  function find(nodes: HierarchyNode[], parent: HierarchyNode | null): { node: HierarchyNode; parent: HierarchyNode | null } | null {
    for (const node of nodes) {
      if (node.document_id === documentId) return { node, parent };
      const hit = find(node.children ?? [], node);
      if (hit) return hit;
    }
    return null;
  }
  const hit = find(roots, null);
  if (!hit) return [];
  const related: RelatedDocument[] = [];
  if (hit.parent) {
    related.push(fromNode(hit.parent, "parent"));
    for (const sibling of hit.parent.children ?? []) {
      if (sibling.document_id !== documentId) related.push(fromNode(sibling, "sibling"));
    }
  }
  for (const child of hit.node.children ?? []) related.push(fromNode(child, "child"));
  return related;
}

/** Hierarchy plus the document's own child links, de-duplicated. Either
 * call failing just narrows the list; both failing yields none. */
export async function loadRelatedDocuments(documentId: string): Promise<RelatedDocument[]> {
  const [hierarchy, children] = await Promise.allSettled([
    getDocumentHierarchy(),
    getChildRelationships(documentId),
  ]);
  const related = hierarchy.status === "fulfilled" ? relatedFromHierarchy(hierarchy.value.roots ?? [], documentId) : [];
  const seen = new Set(related.map((item) => item.documentId));
  if (children.status === "fulfilled") {
    for (const child of children.value.children ?? []) {
      if (seen.has(child.child_document_id) || child.child_document_id === documentId) continue;
      seen.add(child.child_document_id);
      related.push({
        documentId: child.child_document_id,
        title: child.child_document_title,
        documentNumber: child.child_document_number,
        relationshipType: child.relationship_type || null,
        relationshipStatus: child.status,
        role: "child",
      });
    }
  }
  return related;
}

export const RELATED_ROLE_LABEL: Record<RelatedRole, string> = {
  parent: "Parent",
  sibling: "Related",
  child: "Child",
};
