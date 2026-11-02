/**
 * Once per page load, account and source: the activity this browser kept for the account on retired
 * rollups, or a source generation rebuilt, carried into this rollup's stores. An account switch during
 * the read drops the import, and the next boot tries again; the writes hold the session lock, so no
 * switch lands between them.
 */
import {
  importHistoricActivity,
  importHistoricContacts,
  SIPADepositStore,
  task,
  type ContactStorage,
  type HistoricActivityImported,
  type Resource,
  type RetiredDatabase,
  type Task,
} from "@obsidion/front-core"
import { getActiveStorageId, withSessionLock } from "../../platform/storage/activeStorage"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { session } from "../../platform/session"
import { getSavingsMoveStore } from "../savings/savingsMoveStore"

const imports = new Map<string, Promise<HistoricActivityImported | null>>()

/** A database from elsewhere, read only when its own marker is absent. */
export interface HistoricSource {
  key: string
  read(): Promise<RetiredDatabase>
}

/** This browser's retired databases, or `from` in their place. */
export function importHistoricActivityOnce(
  storageId: string,
  from?: HistoricSource,
): Promise<HistoricActivityImported | null> {
  const memo = `${from?.key ?? ""}\n${storageId}`
  let run = imports.get(memo)
  if (!run) {
    run = importHistoricActivity({
      storage: webStorage,
      key: from?.key,
      readOtherDatabases: from
        ? async (read) => [read(await from.read())]
        : (read) => webStorage.readOtherDatabases(read),
      transactions: session().activity,
      sipaDeposits: SIPADepositStore.get(webStorage),
      withdrawals: session().withdrawals,
      savingsMoves: getSavingsMoveStore(),
      ownsStorage: () => getActiveStorageId() === storageId,
      holdSession: withSessionLock,
    })
    imports.set(memo, run)
    run.catch(() => {
      if (imports.get(memo) === run) imports.delete(memo)
    })
  }
  return run
}

/**
 * The activity and contacts this browser kept for the account on retired rollups, once per session;
 * a failed import is tried again next boot. They wait for the wallet: the rows carry its network.
 */
export function historicImports(
  wallet: Resource<unknown>,
  { storageId, contacts }: { storageId: string; contacts: ContactStorage },
  imports = {
    activity: importHistoricActivityOnce,
    contacts: (storageId: string, contacts: ContactStorage) =>
      importHistoricContacts({
        storage: webStorage,
        readOtherDatabases: (read) => webStorage.readOtherDatabases(read),
        contacts,
        ownsStorage: () => getActiveStorageId() === storageId,
        holdSession: withSessionLock,
      }),
  },
): Task[] {
  return [
    task("historicActivity", {
      needs: { wallet },
      after: {
        firstBalance: true,
        depositsReplayed: true,
        movesReplayed: true,
        historyAtHead: true,
      },
      every: "once",
      run: async () => void (await imports.activity(storageId)),
    }),
    task("historicContacts", {
      needs: { wallet },
      every: "once",
      run: async () => void (await imports.contacts(storageId, contacts)),
    }),
  ]
}
