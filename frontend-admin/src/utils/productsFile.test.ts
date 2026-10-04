import { describe, it, expect } from "vitest";
import { autoMap, decodeCsv, findHeaderRow, parseCsv, productsCsv, toImportRows, type ExportProduct } from "./productsFile";

// Файл товаров: свой шаблон, выгрузка из 1С, CSV из русского Excel.

describe("columns", () => {
  it("knows our own export and template", () => {
    const m = autoMap(["Название", "Штрихкод", "Артикул", "Категория", "Ед. изм.", "Цена продажи", "Себестоимость", "Остаток", "Мин. остаток", "Активен", "ИКПУ"]);
    expect(m).toEqual({ name: 0, barcode: 1, sku: 2, category: 3, unit: 4, price: 5, costPrice: 6, stock: 7, minStock: 8 });
  });

  it("knows the way 1С names them", () => {
    const m = autoMap(["Код", "Номенклатура", "Штрих-код", "Группа", "Ед.изм.", "Цена розничная", "Цена закупки", "Количество"]);
    expect(m).toMatchObject({ sku: 0, name: 1, barcode: 2, category: 3, unit: 4, price: 5, costPrice: 6, stock: 7, minStock: null });
  });

  it("matches a title with a tail and never gives one column to two fields", () => {
    const m = autoMap(["Наименование товара", "Цена, сўм", "Цена закупки, сўм"]);
    expect(m).toMatchObject({ name: 0, price: 1, costPrice: 2 });
  });

  it("finds the header row under a 1С report title", () => {
    const rows = [["Остатки товаров на 04.10.2026"], [null], ["Номенклатура", "Штрихкод", "Остаток"], ["Чай", "4780000000001", 5]];
    expect(findHeaderRow(rows)).toBe(2);
  });
});

describe("csv", () => {
  it("reads semicolons, quotes and a BOM", () => {
    const rows = parseCsv('\uFEFFНазвание;Цена\r\n"Сок ""Bliss"" 1 л";"14 000,50"\r\nВода;3000\r\n');
    expect(rows).toEqual([["Название", "Цена"], ['Сок "Bliss" 1 л', "14 000,50"], ["Вода", "3000"]]);
  });

  it("reads commas and a semicolon inside quotes", () => {
    expect(parseCsv('name,price\n"Чай; чёрный",16500')).toEqual([["name", "price"], ["Чай; чёрный", "16500"]]);
  });

  it("falls back to Windows-1251, the way 1С saves", () => {
    // «Чай» в Windows-1251
    const bytes = new Uint8Array([0xd7, 0xe0, 0xe9]).buffer;
    expect(decodeCsv(bytes)).toBe("Чай");
    expect(decodeCsv(new TextEncoder().encode("Чай").buffer as ArrayBuffer)).toBe("Чай");
  });
});

describe("rows", () => {
  const rows = [
    ["Название", "Штрихкод", "Цена", "Остаток"],
    ["Coca-Cola 1 л", 5449000000439, 9000, 24],
    [null, null, null, null],
    ["Чай", "054881005500", "16 500", ""],
  ];
  const mapping = { ...autoMap(rows[0]) };

  it("numbers rows like Excel, skips empty ones, keeps long barcodes whole", () => {
    expect(toImportRows(rows, 0, mapping)).toEqual([
      { row: 2, name: "Coca-Cola 1 л", barcode: "5449000000439", sku: undefined, price: 9000, costPrice: undefined, stock: 24, unit: undefined, category: undefined, minStock: undefined },
      { row: 4, name: "Чай", barcode: "054881005500", sku: undefined, price: "16 500", costPrice: undefined, stock: undefined, unit: undefined, category: undefined, minStock: undefined },
    ]);
  });
});

describe("export", () => {
  const p: ExportProduct = { name: "Сок; яблочный", barcode: "054881005500", sku: null, category: "Напитки", unit: "кг", price: 14000.5, costPrice: 11000, stock: null, minStock: 0, active: true, ikpu: null };

  it("writes CSV the Russian Excel opens: BOM, semicolons, comma decimals", () => {
    const csv = productsCsv([p]);
    expect(csv.startsWith("\uFEFFНазвание;Штрихкод;")).toBe(true);
    expect(csv.split("\r\n")[1]).toBe('"Сок; яблочный";054881005500;;Напитки;кг;14000,5;11000;;0;да;');
  });

  it("reads its own export back to the same columns", () => {
    const back = parseCsv(productsCsv([p]));
    const m = autoMap(back[0]);
    expect(toImportRows(back, 0, m)[0]).toMatchObject({ name: "Сок; яблочный", barcode: "054881005500", category: "Напитки", unit: "кг", price: "14000,5" });
  });
});
