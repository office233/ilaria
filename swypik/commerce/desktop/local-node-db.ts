import fs from 'node:fs';
import path from 'node:path';

export interface PosReceiptRecord {
  receiptNumber: string;
  totalRon: number;
  tvaRon?: number;
  paymentMethod?: string;
  recordedAt?: string;
  [key: string]: unknown;
}

export interface LocalNodeData {
  nodeId: string;
  storeCatalog: Array<Record<string, unknown>>;
  posReceiptsJournal: PosReceiptRecord[];
  syncStatus: {
    lastSyncedAt: string;
    pendingSyncCount: number;
    isOnline: boolean;
  };
}

/**
 * Fișierul de date al nodului local. Implicit în directorul de date al
 * utilizatorului, NU în repo — versiunea anterioară scria în
 * desktop/swypik-local-node.json (urmărit de git) și fiecare rulare de teste
 * murdărea working tree-ul. SWYPIK_LOCAL_NODE_DB suprascrie calea (teste, CI).
 */
function defaultDbFile(): string {
  if (process.env.SWYPIK_LOCAL_NODE_DB) return process.env.SWYPIK_LOCAL_NODE_DB;
  const base =
    process.env.APPDATA ||
    process.env.XDG_DATA_HOME ||
    path.join(process.env.HOME || process.cwd(), '.local', 'share');
  return path.join(base, 'swypik-business-erp', 'local-node.json');
}

/**
 * Embedded Local Node Database for Swypik Business ERP Desktop
 */
export class LocalNodeDatabase {
  public data: LocalNodeData;
  private readonly dbFile: string;

  constructor(dbFile: string = defaultDbFile()) {
    this.dbFile = dbFile;
    this.data = {
      nodeId: "NODE-RO-" + Date.now().toString(36).toUpperCase(),
      storeCatalog: [],
      posReceiptsJournal: [],
      syncStatus: {
        lastSyncedAt: new Date().toISOString(),
        pendingSyncCount: 0,
        isOnline: true,
      },
    };
    this.load();
  }

  public load(): void {
    if (fs.existsSync(this.dbFile)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.dbFile, 'utf8'));
      } catch {
        // use defaults
      }
    } else {
      this.save();
    }
  }

  public save(): void {
    try {
      const dir = path.dirname(this.dbFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.dbFile, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      // non-blocking
    }
  }

  public recordReceipt(receipt: PosReceiptRecord): PosReceiptRecord {
    if (!this.data.syncStatus.isOnline) {
      throw new Error("Nodul este offline! Tranzacțiile sunt blocate deoarece conexiunea la rețeaua Swypik este obligatorie.");
    }
    const rec = {
      ...receipt,
      recordedAt: new Date().toISOString(),
    };
    this.data.posReceiptsJournal.push(rec);
    this.save();
    return rec;
  }

  public getNodeInfo() {
    return {
      nodeId: this.data.nodeId,
      receiptsCount: this.data.posReceiptsJournal.length,
      isOnline: this.data.syncStatus.isOnline,
      lastSyncedAt: this.data.syncStatus.lastSyncedAt,
    };
  }
}
