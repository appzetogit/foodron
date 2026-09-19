import ExcelJS from 'exceljs';
import {
    ADDON_COLUMNS,
    BulkImportError,
    ERROR,
    FOOD_COLUMNS,
    INFORMATIONAL_COLUMNS,
    LIMITS,
    SHEET_ADDONS,
    SHEET_FOODS
} from './constants.js';

const normalizeHeader = (value) =>
    String(value ?? '')
        .replace(/\*/g, '')
        .replace(/[\s_\-]+/g, '')
        .trim()
        .toLowerCase();

/** exceljs cell values come in many shapes (rich text, formula results, hyperlinks...). */
export const cellToPrimitive = (value) => {
    if (value == null) return null;
    if (value instanceof Date) return value;
    if (typeof value === 'object') {
        if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
        if ('result' in value) return cellToPrimitive(value.result);
        if ('text' in value) return cellToPrimitive(value.text);
        if ('error' in value) return null;
        return String(value);
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed === '' ? null : trimmed;
    }
    return value;
};

const buildHeaderMap = (headerRow, columns) => {
    const known = new Map();
    for (const column of [...columns, ...INFORMATIONAL_COLUMNS.map((key) => ({ key }))]) {
        known.set(normalizeHeader(column.key), column.key);
    }

    const columnIndexByKey = new Map();
    const unknown = [];

    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const label = cellToPrimitive(cell.value);
        if (label == null || String(label).trim() === '') return;
        const key = known.get(normalizeHeader(label));
        if (!key) {
            unknown.push(String(label));
        } else if (!columnIndexByKey.has(key)) {
            columnIndexByKey.set(key, colNumber);
        }
    });

    return { columnIndexByKey, unknown };
};

const findSheet = (workbook, sheetName) =>
    workbook.worksheets.find((sheet) => sheet.name.trim().toLowerCase() === sheetName.toLowerCase()) || null;

/**
 * Reads one sheet into `{ rows: [{ rowNumber, values }] }` keyed by canonical column name.
 * Header problems (missing sheet, missing required columns, unknown columns) are file-level
 * errors: they affect every row, so we refuse before validating anything else.
 */
const readSheet = (workbook, sheetName, columns) => {
    const sheet = findSheet(workbook, sheetName);
    if (!sheet) {
        throw new BulkImportError(ERROR.MISSING_SHEET, `The workbook has no "${sheetName}" sheet.`);
    }

    const headerRow = sheet.getRow(1);
    const { columnIndexByKey, unknown } = buildHeaderMap(headerRow, columns);

    const missing = columns.filter((column) => column.required && !columnIndexByKey.has(column.key)).map((c) => c.key);
    const groups = new Map();
    for (const column of columns) {
        if (!column.oneOf) continue;
        if (!groups.has(column.oneOf)) groups.set(column.oneOf, []);
        groups.get(column.oneOf).push(column.key);
    }
    for (const [group, keys] of groups) {
        if (!keys.some((key) => columnIndexByKey.has(key))) missing.push(`${keys.join(' or ')} (${group})`);
    }
    if (missing.length) {
        throw new BulkImportError(
            ERROR.MISSING_COLUMNS,
            `Sheet "${sheetName}" is missing required column(s): ${missing.join(', ')}.`
        );
    }
    if (unknown.length) {
        // Never silently drop data: an unrecognised column would be ignored, so refuse.
        throw new BulkImportError(
            ERROR.UNSUPPORTED_COLUMNS,
            `Sheet "${sheetName}" has unsupported column(s): ${unknown.join(', ')}. Remove them or use the downloaded template.`
        );
    }

    const rows = [];
    const lastRow = sheet.actualRowCount ? sheet.rowCount : 0;
    for (let rowNumber = 2; rowNumber <= lastRow; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        const values = {};
        let hasData = false;
        for (const [key, colNumber] of columnIndexByKey) {
            const value = cellToPrimitive(row.getCell(colNumber).value);
            values[key] = value;
            if (value != null) hasData = true;
        }
        if (!hasData) continue;
        rows.push({ rowNumber, values });
        if (rows.length > LIMITS.maxRowsPerSheet) {
            throw new BulkImportError(
                ERROR.TOO_MANY_ROWS,
                `Sheet "${sheetName}" has more than ${LIMITS.maxRowsPerSheet} rows. Split the import into smaller files.`
            );
        }
    }

    return rows;
};

/**
 * Parse menu.xlsx. `entity` decides which sheets are required and read:
 * food -> Foods, addon -> Addons, both -> both. Other sheets are ignored.
 */
export async function readMenuWorkbook(workbookPath, entity) {
    const workbook = new ExcelJS.Workbook();
    try {
        await workbook.xlsx.readFile(workbookPath);
    } catch (err) {
        throw new BulkImportError(ERROR.INVALID_WORKBOOK, 'menu.xlsx could not be read. Save it as a regular .xlsx workbook.');
    }

    const result = { foods: [], addons: [] };
    if (entity === 'food' || entity === 'both') {
        result.foods = readSheet(workbook, SHEET_FOODS, FOOD_COLUMNS);
    }
    if (entity === 'addon' || entity === 'both') {
        result.addons = readSheet(workbook, SHEET_ADDONS, ADDON_COLUMNS);
    }
    if (result.foods.length + result.addons.length === 0) {
        throw new BulkImportError(ERROR.EMPTY_SHEET, 'menu.xlsx has no data rows in the selected sheet(s).');
    }
    return result;
}
