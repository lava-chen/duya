/** Desktop compatibility entry; the Electron-independent importer lives in @duya/data. */
export {
  LegacyImport,
  legacyRowToNewEvent,
  openLegacyReadonly,
  readLegacyRows,
  sortSessionMessages,
} from '@duya/data';
export type {
  ImportReport,
  LegacyAttachmentRow,
  LegacyImportStores,
  LegacyLockRow,
  LegacyMailboxRow,
  LegacyMessageRow,
  LegacyPermissionRow,
  LegacyRows,
  LegacySessionRow,
  LegacyTaskRow,
  SortResult,
} from '@duya/data';
