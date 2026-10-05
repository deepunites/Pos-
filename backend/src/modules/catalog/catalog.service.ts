import prisma from "../../config/database.js";
import { ConflictError, NotFoundError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { liveLookup, probeOff } from "./catalog.off.js";
import type { CatalogAddInput } from "./catalog.schema.js";
import { liveTasnif, nationalFrom, probeTasnif, type TasnifProduct } from "./catalog.tasnif.js";
import { SHELF_NAMES, shelfFromName } from "./categories.js";
import { barcodeVariants, canonicalBarcode, hasUzbekPrefix, isCatalogBarcode } from "./gtin.js";
import { cleanName, displayName } from "./names.js";

export interface CatalogHit {
  found: true;
  barcode: string;
  name: string;
  brand: string | null;
  quantity: string | null;
  category: string | null;
  /** brand + name + pack size, ready to become the product's name */
  displayName: string;
  /** the 17-digit IKPU code of the national tax catalogue, when it is known */
  ikpu: string | null;
  /** snapshot — shipped with the app; off — found on Open Food Facts; tasnif — the national catalogue of Uzbekistan; crowd — entered by a shop */
  source: string;
}

export interface CatalogMiss {
  found: false;
  barcode: string;
  /** false: not a world-unique product code (mistyped, cut short, or a shop's own label) */
  valid: boolean;
}

interface Row {
  barcode: string;
  name: string;
  brand: string | null;
  quantity: string | null;
  category: string | null;
  ikpu: string | null;
  source: string;
}

const toHit = (row: Row): CatalogHit => ({
  found: true,
  barcode: row.barcode,
  name: row.name,
  brand: row.brand,
  quantity: row.quantity,
  // Where the record names no shelf, the name itself often does ("Молоко Простоквашино").
  category: row.category ?? shelfFromName(row.name),
  displayName: displayName(row.name, row.quantity, row.brand),
  ikpu: row.ikpu,
  source: row.source,
});

// Codes nobody knew are not asked about again for half a day: a shop that scans
// the same unlisted item twenty times should cost the public API one request.
const MISS_TTL_MS = 12 * 60 * 60 * 1000;
const MISS_LIMIT = 20_000;
const misses = new Map<string, number>();
const inflight = new Map<string, Promise<CatalogHit | null>>();
const upgrading = new Map<string, Promise<Row>>();

// What volunteers typed into Open Food Facts about an Uzbek code is often a word or two; the
// national catalogue has the brand and the pack. Asking it must not hold a scan up for long.
const UPGRADE_TIMEOUT_MS = 2500;

function knownMiss(code: string): boolean {
  const until = misses.get(code);
  if (until === undefined) return false;
  if (until < Date.now()) {
    misses.delete(code);
    return false;
  }
  return true;
}

function rememberMiss(code: string): void {
  if (misses.size >= MISS_LIMIT) misses.delete(misses.keys().next().value as string);
  misses.set(code, Date.now() + MISS_TTL_MS);
}

const PALETTE = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];
const colorFor = (name: string) => PALETTE[Array.from(name).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % PALETTE.length];
const same = (a: string, b: string) => a.toLowerCase().replace(/\s+/g, " ").trim() === b.toLowerCase().replace(/\s+/g, " ").trim();

function parseMetadata(text: string | null): Record<string, unknown> {
  try {
    const value = JSON.parse(text || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

let statsCache: { at: number; value: { total: number; crowd: number } } | null = null;

export class CatalogService {
  /**
   * What is known about a barcode: our own base first, then — once — the public catalogues.
   * `nationalRecord` is what the shop's browser got from the national catalogue of Uzbekistan,
   * which the server often cannot reach itself (see catalog.tasnif.ts).
   */
  async lookup(rawCode: string, nationalRecord?: unknown): Promise<CatalogHit | CatalogMiss> {
    const code = rawCode.trim();
    if (!isCatalogBarcode(code)) return { found: false, barcode: code, valid: false };
    const canonical = canonicalBarcode(code);

    const hit = await this.find(code, canonical);
    const national = nationalFrom(nationalRecord, Array.from(new Set([code, canonical, ...barcodeVariants(code)])));
    return this.withNational(hit, national, canonical) ?? { found: false, barcode: canonical, valid: true };
  }

  private async find(code: string, canonical: string): Promise<CatalogHit | null> {
    const stored = await prisma.catalogProduct.findFirst({ where: { barcode: { in: barcodeVariants(code) } } });
    if (stored) return toHit(this.worthAskingNationalCatalogue(stored) ? await this.upgradeFromNational(stored) : stored);
    if (knownMiss(canonical)) return null;
    return this.askLive(canonical);
  }

  // What the browser brought from the national catalogue is shown, never stored in the shared base:
  // the server cannot check it, so it must not pass for an official record to other shops.
  // For an Uzbek code its words win over Open Food Facts' and the snapshot's (not over a shop's own);
  // for any other the open catalogue's stay, and the IKPU is added.
  private withNational(hit: CatalogHit | null, national: TasnifProduct | null, canonical: string): CatalogHit | null {
    if (!national || hit?.source === "tasnif") return hit;
    const fromNational = (fallback: CatalogHit | null): CatalogHit =>
      toHit({
        barcode: canonical,
        name: national.name,
        brand: national.brand ?? fallback?.brand ?? null,
        quantity: national.quantity ?? fallback?.quantity ?? null,
        category: national.category ?? fallback?.category ?? null,
        ikpu: national.ikpu,
        source: "tasnif",
      });
    if (!hit) return fromNational(null);
    if (hasUzbekPrefix(canonical) && hit.source !== "crowd") return fromNational(hit);
    return { ...hit, ikpu: hit.ikpu ?? national.ikpu };
  }

  // An Uzbek code (478…) whose record came from Open Food Facts rather than from a shop or the
  // national catalogue: that catalogue knows Uzbek goods better, so it is asked — once.
  private worthAskingNationalCatalogue(row: Row): boolean {
    return hasUzbekPrefix(row.barcode) && (row.source === "snapshot" || row.source === "off") && !row.ikpu && !knownMiss("uz:" + row.barcode);
  }

  private upgradeFromNational(row: Row): Promise<Row> {
    let pending = upgrading.get(row.barcode);
    if (!pending) {
      pending = this.askNational(row).finally(() => upgrading.delete(row.barcode));
      upgrading.set(row.barcode, pending);
    }
    return pending;
  }

  private async askNational(row: Row): Promise<Row> {
    const { product, complete } = await liveTasnif(row.barcode, UPGRADE_TIMEOUT_MS);
    if (!product) {
      if (complete) rememberMiss("uz:" + row.barcode);
      return row;
    }
    return prisma.catalogProduct.update({
      where: { barcode: row.barcode },
      data: { name: product.name, brand: product.brand, quantity: product.quantity, category: product.category, ikpu: product.ikpu, source: "tasnif" },
    });
  }

  // Simultaneous scans of one unknown code share a single trip to the network.
  private askLive(code: string): Promise<CatalogHit | null> {
    let pending = inflight.get(code);
    if (!pending) {
      pending = this.fetchLive(code).finally(() => inflight.delete(code));
      inflight.set(code, pending);
    }
    return pending;
  }

  // A code nobody here has described: Open Food Facts and the national catalogue of Uzbekistan are
  // asked together. For an Uzbek code the national catalogue's words win, for any other the open
  // catalogue's (they read better); what only one of them knows — the IKPU, the shelf — is kept.
  private async fetchLive(code: string): Promise<CatalogHit | null> {
    const [national, open] = await Promise.all([liveTasnif(code), liveLookup(code)]);
    const chosen = hasUzbekPrefix(code) ? national.product ?? open.product : open.product ?? national.product;
    if (!chosen) {
      if (national.complete && open.complete) rememberMiss(code);
      return null;
    }
    const other = chosen === national.product ? open.product : national.product;
    const row = await prisma.catalogProduct.upsert({
      where: { barcode: code },
      create: {
        barcode: code,
        name: chosen.name,
        brand: chosen.brand ?? other?.brand ?? null,
        quantity: chosen.quantity ?? other?.quantity ?? null,
        category: chosen.category ?? other?.category ?? null,
        ikpu: national.product?.ikpu ?? null,
        source: chosen === national.product ? "tasnif" : "off",
      },
      update: {},
    });
    return toHit(row);
  }

  /** Which of the public catalogues can this server reach? Logged at start, since a cloud address may be turned away. */
  async probeSources(): Promise<{ openFoodFacts: boolean; nationalCatalogue: boolean; nationalMs: number; nationalError?: string }> {
    const [openFoodFacts, national] = await Promise.all([probeOff(), probeTasnif()]);
    return { openFoodFacts, nationalCatalogue: national.ok, nationalMs: national.ms, ...(national.error ? { nationalError: national.error } : {}) };
  }

  /**
   * A shop's own product enriches the shared base: only the barcode, the name and
   * the shelf leave the shop — never a price or a stock figure — and only if the
   * shop has not opted out. Never throws: sharing must not break saving a product.
   */
  async contribute(tenantId: string, item: { barcode?: string | null; name: string; category?: string | null }): Promise<void> {
    try {
      const code = (item.barcode ?? "").trim();
      if (!isCatalogBarcode(code)) return;
      const name = cleanName(item.name);
      if (name.length < 2 || /^[\d\s.,-]+$/.test(name)) return;

      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { catalogSharing: true } });
      if (!tenant?.catalogSharing) return;

      const existing = await prisma.catalogProduct.findFirst({ where: { barcode: { in: barcodeVariants(code) } } });
      if (!existing) {
        // Only the fixed list of shelf names is shared — a shop's own category names stay its own.
        const shelf = item.category && SHELF_NAMES.includes(item.category) ? item.category : null;
        await prisma.catalogProduct.create({ data: { barcode: canonicalBarcode(code), name, category: shelf, source: "crowd" } });
        return;
      }
      // Another shop typed the very same name: that is a confirmation, nothing more.
      // What the shipped snapshot or the public catalogues say is never overwritten.
      if (existing.source === "crowd" && same(displayName(existing.name, existing.quantity, existing.brand), name)) {
        await prisma.catalogProduct.update({ where: { barcode: existing.barcode }, data: { confirmations: { increment: 1 } } });
      }
    } catch (error) {
      // A racing insert of the same code from another shop lands here too — that is fine.
      logger.warn("Catalogue contribution skipped", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Creates the shop's product from a scan: the catalogue supplied the name, the shop supplies the price. */
  async add(tenantId: string, input: CatalogAddInput) {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { defaultMarkupPercent: true, businessType: true } });
    // The IKPU the invoice and the receipt will need travels with the product — read here, not taken from the client.
    const known = await prisma.catalogProduct.findFirst({ where: { barcode: { in: barcodeVariants(input.barcode) } }, select: { ikpu: true } });
    const ikpu = input.ikpu ?? known?.ikpu ?? null;

    const product = await prisma.$transaction(async (tx) => {
      const duplicate = await tx.product.findFirst({ where: { tenantId, barcode: { in: barcodeVariants(input.barcode) } }, select: { id: true, name: true, isActive: true, metadata: true } });
      if (duplicate?.isActive) throw new ConflictError(`Товар с этим штрихкодом уже есть: «${duplicate.name}»`);
      // Archived earlier: adding it again means bringing it back, at the price just entered —
      // and with the IKPU, if the catalogue has learnt it since.
      if (duplicate) {
        const metadata = parseMetadata(duplicate.metadata);
        if (ikpu && !metadata.ikpu) metadata.ikpu = ikpu;
        return tx.product.update({ where: { id: duplicate.id }, data: { isActive: true, price: input.price, metadata: JSON.stringify(metadata) }, include: { category: true } });
      }

      let categoryId: string | null = null;
      if (input.categoryId) {
        const owned = await tx.category.findFirst({ where: { id: input.categoryId, tenantId }, select: { id: true } });
        if (!owned) throw new NotFoundError("Категория не найдена");
        categoryId = owned.id;
      } else if (input.categoryName) {
        const wanted = input.categoryName.toLowerCase();
        const shelves = await tx.category.findMany({ where: { tenantId, isIngredient: false }, select: { id: true, name: true } });
        categoryId =
          shelves.find((shelf) => shelf.name.trim().toLowerCase() === wanted)?.id ??
          (await tx.category.create({ data: { tenantId, name: input.categoryName, color: colorFor(input.categoryName), markupPercent: tenant?.defaultMarkupPercent ?? 0 } })).id;
      }

      return tx.product.create({
        data: {
          tenantId,
          categoryId,
          name: input.name,
          barcode: input.barcode,
          price: input.price,
          costPrice: input.costPrice ?? 0,
          unit: input.weighed ? "kg" : "piece",
          saleUnit: input.weighed ? "кг" : null,
          // Магазин ведёт остаток у каждого товара; кафе — только если его указали.
          trackInventory: tenant?.businessType === "retail" || input.stock !== undefined,
          currentStock: input.stock ?? 0,
          metadata: ikpu ? JSON.stringify({ ikpu }) : undefined,
        },
        include: { category: true },
      });
    });

    void this.contribute(tenantId, { barcode: product.barcode, name: product.name, category: product.category?.name });
    return product;
  }

  async stats() {
    if (statsCache && Date.now() - statsCache.at < 5 * 60_000) return statsCache.value;
    const [total, crowd] = await Promise.all([prisma.catalogProduct.count(), prisma.catalogProduct.count({ where: { source: "crowd" } })]);
    statsCache = { at: Date.now(), value: { total, crowd } };
    return statsCache.value;
  }
}

export const catalogService = new CatalogService();
