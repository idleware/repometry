export const historySchema = 'urn:repometry:schema:public-history:1';
export function compareHistoryEntries(a, b) {
    return Number(b.committedAt !== undefined) - Number(a.committedAt !== undefined)
        || (b.committedAt ?? b.generatedAt).localeCompare(a.committedAt ?? a.generatedAt)
        || a.sha.localeCompare(b.sha);
}
