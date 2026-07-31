export interface TaggedTransactionRef {
  id: string;
  tagIds: string[];
}

/** Ids of transactions that already carry the given tag id. */
export function findTaggedTransactionIds(transactions: TaggedTransactionRef[], tagId: string): string[] {
  return transactions.filter((t) => t.tagIds.includes(tagId)).map((t) => t.id);
}
