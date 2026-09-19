import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import sharp from 'sharp';
import { listRestaurantCategories } from '../restaurant/services/restaurantCategory.service.js';
import {
    ADDON_COLUMNS,
    ALLOWED_IMAGE_EXTENSIONS,
    BULK_ENTITY,
    FOOD_COLUMNS,
    LIMITS,
    basicColumns,
    SHEET_ADDONS,
    SHEET_FOODS,
    SHEET_README,
    WORKBOOK_NAME
} from './constants.js';

const REQUIRED_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE0E0' } };
const OPTIONAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };

const LISTS = {
    foodType: '"Veg,Non-Veg"',
    discountType: '"Percent,Amount"',
    isAvailable: '"TRUE,FALSE"',
    isRecommended: '"TRUE,FALSE"'
};

const addDataSheet = (workbook, name, columns, sampleRows = []) => {
    const sheet = workbook.addWorksheet(name);
    sheet.columns = columns.map((column) => ({
        header: column.key,
        key: column.key,
        width: Math.max(14, column.key.length + 4)
    }));
    // Example rows first: dropdown validations below touch rows 2..1001 and would push later rows down.
    for (const row of sampleRows) sheet.addRow(columns.map((column) => row[column.key] ?? null));
    const header = sheet.getRow(1);
    header.font = { bold: true };
    columns.forEach((column, i) => {
        const cell = header.getCell(i + 1);
        cell.fill = column.required || column.oneOf ? REQUIRED_FILL : OPTIONAL_FILL;
        if (LISTS[column.key]) {
            for (let row = 2; row <= 1001; row += 1) {
                sheet.getCell(row, i + 1).dataValidation = {
                    type: 'list',
                    allowBlank: true,
                    formulae: [LISTS[column.key]]
                };
            }
        }
    });
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    return sheet;
};

const requirementLabel = (column) => {
    if (column.required) return 'Required';
    if (column.oneOf === 'category') return 'Required (categoryName or categoryId)';
    if (column.oneOf === 'price') return 'Required (price, unless variants is given)';
    return 'Optional';
};

const addColumnTable = (sheet, title, columns) => {
    sheet.addRow([]);
    sheet.addRow([title]).font = { bold: true, size: 12 };
    const head = sheet.addRow(['Column', 'Requirement', 'Notes']);
    head.font = { bold: true };
    columns.forEach((column) => sheet.addRow([column.key, requirementLabel(column), column.note]));
};

const addReadme = (workbook, entity, isAdmin, foodColumns, addonColumns, full) => {
    const sheet = workbook.addWorksheet(SHEET_README);
    sheet.getColumn(1).width = 26;
    sheet.getColumn(2).width = 40;
    sheet.getColumn(3).width = 110;

    sheet.addRow(['Fudron bulk menu import']).font = { bold: true, size: 14 };
    sheet.addRow([]);
    sheet.addRow(['1. ZIP structure']).font = { bold: true };
    sheet.addRow([`fudron-menu-import.zip`]);
    sheet.addRow([`  ${WORKBOOK_NAME}   <- this workbook, saved at the ROOT of the ZIP (not inside a folder)`]);
    sheet.addRow(['  images/           <- every image referenced in the workbook']);
    sheet.addRow([`  Allowed image types: ${ALLOWED_IMAGE_EXTENSIONS.join(', ')}. Max ${Math.round(LIMITS.maxImageBytes / 1024 / 1024)}MB each.`]);
    sheet.addRow([`  Max ${LIMITS.maxRowsPerSheet} rows per sheet. Select the files (not a folder) when creating the ZIP.`]);
    sheet.addRow([]);
    sheet.addRow(['2. Image mapping']).font = { bold: true };
    sheet.addRow(['The image column must contain an exact file name that exists in images/ (case-sensitive). Names are never guessed from item names.']);
    sheet.addRow(['Example: image = F001.webp requires images/F001.webp in the ZIP. Extra images: images = F001-2.webp,F001-3.webp.']);
    sheet.addRow([]);
    sheet.addRow(['3. Approval']).font = { bold: true };
    sheet.addRow([
        isAdmin
            ? 'Admin imports are approved immediately (food: approved; add-ons: approved and published).'
            : 'Restaurant imports are submitted for admin approval (food: pending; add-ons: pending).'
    ]);
    sheet.addRow([]);
    sheet.addRow(['4. Rules']).font = { bold: true };
    sheet.addRow(['Rows are validated with the same rules as adding one item at a time. Invalid rows are reported with a reason; valid rows can still be imported.']);
    sheet.addRow(['Codes (itemCode / addonCode) must be unique inside the file. They exist only to identify rows in the report and are not saved.']);
    sheet.addRow(['A restaurantId column is optional and never used to choose the restaurant; if present it must match the restaurant you are importing into.']);

    if (entity !== BULK_ENTITY.ADDON) {
        sheet.addRow([]);
        sheet.addRow(['Food rules']).font = { bold: true };
        sheet.addRow(['Categories must already exist, be active, approved, and be either global or owned by this restaurant. Pending, rejected or inactive categories are rejected.']);
        sheet.addRow(['A category name matching several categories is reported as ambiguous: use categoryId instead.']);
        sheet.addRow(['Veg categories accept only Veg food; Non-Veg categories only Non-Veg. Pure-veg restaurants can only import Veg food.']);
        sheet.addRow(['Variants: JSON array in one cell, e.g. [{"name":"Regular","price":149,"otherPrice":0,"unit":"piece"},{"name":"Large","price":199,"otherPrice":0,"unit":"piece"}]']);
        sheet.addRow(['Food names are not unique. Rows matching an existing food (same restaurant, category and name) are flagged as duplicates; you choose to Skip them or Create anyway.']);
        addColumnTable(sheet, 'Foods sheet columns', foodColumns);
    }
    if (entity !== BULK_ENTITY.FOOD) {
        sheet.addRow([]);
        sheet.addRow(['Add-on rules']).font = { bold: true };
        sheet.addRow(['Add-ons are a restaurant-level catalogue. They are NOT attached to specific food items.']);
        sheet.addRow(['Add-on names must be unique per restaurant (case-insensitive); duplicates are rejected.']);
        addColumnTable(sheet, 'Addons sheet columns', addonColumns);
    }
    if (!full) {
        sheet.addRow([]);
        sheet.addRow(['Need variants (sizes), several images, discounts, tags or availability times? Download the template with advanced columns.']);
    }
    sheet.addRow([]);
    sheet.addRow(['Example - Foods row']).font = { bold: true };
    sheet.addRow(['itemCode=F001, name=Cheese Burger, categoryName=Burger, price=149, foodType=Veg, image=F001.webp']);
    sheet.addRow(['Example - Addons row']).font = { bold: true };
    sheet.addRow(['addonCode=A001, name=Extra Cheese, description=Cheese, price=30, foodType=Veg, image=A001.webp']);
};

/** Build the downloadable template workbook (columns come from constants.js = parser truth). */
export async function buildTemplateBuffer(entity, { isAdmin = false, sample = null, full = false } = {}) {
    const workbook = new ExcelJS.Workbook();
    const foodColumns = full ? FOOD_COLUMNS : basicColumns(FOOD_COLUMNS);
    const addonColumns = full ? ADDON_COLUMNS : basicColumns(ADDON_COLUMNS);
    if (entity !== BULK_ENTITY.ADDON) addDataSheet(workbook, SHEET_FOODS, foodColumns, sample?.foods || []);
    if (entity !== BULK_ENTITY.FOOD) addDataSheet(workbook, SHEET_ADDONS, addonColumns, sample?.addons || []);
    addReadme(workbook, entity, isAdmin, foodColumns, addonColumns, full);
    return workbook.xlsx.writeBuffer();
}

const solidWebp = (color) =>
    sharp({ create: { width: 320, height: 320, channels: 3, background: color } }).webp({ quality: 80 }).toBuffer();

/**
 * Ready-to-use ZIP package (menu.xlsx at the root + images/ folder), so nobody has to assemble the
 * structure by hand. With `sample: true` it also contains example rows and matching generated
 * images; the food rows use a category this restaurant can really use, so the sample validates and
 * imports as-is. Sample items are named "Sample ..." so they are easy to spot and delete.
 */
export async function buildTemplatePackage(entity, { isAdmin = false, restaurantId = null, sample = false, full = false } = {}) {
    const zip = new JSZip();
    const images = zip.folder('images');
    let sampleRows = null;
    let note = 'Put every image referenced in menu.xlsx into this images/ folder (exact file names).';

    if (sample) {
        sampleRows = { foods: [], addons: [] };
        if (entity !== BULK_ENTITY.ADDON) {
            let category = null;
            if (restaurantId) {
                const { categories } = await listRestaurantCategories(String(restaurantId), { compact: 'true', limit: 200 });
                // Pick a category whose name is unique so categoryName alone resolves unambiguously.
                const counts = new Map();
                (categories || []).forEach((c) => counts.set(String(c.name).toLowerCase(), (counts.get(String(c.name).toLowerCase()) || 0) + 1));
                category = (categories || []).find((c) => counts.get(String(c.name).toLowerCase()) === 1) || null;
            }
            if (category) {
                for (let i = 1; i <= 2; i += 1) {
                    sampleRows.foods.push({
                        itemCode: `F00${i}`,
                        name: `Sample Item ${i} (delete me)`,
                        description: 'Example row generated by the template',
                        categoryName: category.name,
                        categoryId: String(category.id || category._id),
                        price: 100 + i * 10,
                        foodType: category.foodTypeScope === 'Non-Veg' ? 'Non-Veg' : 'Veg',
                        image: `F00${i}.webp`
                    });
                    images.file(`F00${i}.webp`, await solidWebp(i === 1 ? '#e8590c' : '#2f9e44'));
                }
            } else {
                note = 'No usable category was found for this restaurant, so no sample food rows were added. Create a category first.';
            }
        }
        if (entity !== BULK_ENTITY.FOOD) {
            for (let i = 1; i <= 2; i += 1) {
                sampleRows.addons.push({
                    addonCode: `A00${i}`,
                    name: `Sample Add-on ${i} (delete me)`,
                    description: 'Example row generated by the template',
                    price: 10 * i,
                    foodType: 'Veg',
                    image: `A00${i}.webp`
                });
                images.file(`A00${i}.webp`, await solidWebp(i === 1 ? '#1971c2' : '#9c36b5'));
            }
        }
    }

    images.file('PUT-IMAGES-HERE.txt', note);
    zip.file(WORKBOOK_NAME, await buildTemplateBuffer(entity, { isAdmin, sample: sampleRows, full }));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
