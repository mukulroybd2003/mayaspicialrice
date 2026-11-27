import type { ItemMaster, ProductCategory } from '../types/erp';

export function isPaddyItem(item: ItemMaster, categories: ProductCategory[] = []): boolean {
  if (item.process_grade === 'RAW_PADDY') return true;
  const catCode = (item.category || '').toUpperCase();
  if (catCode === 'PADDY' || catCode === 'RAW_PADDY') return true;
  const matchedCat = categories.find((c) => c.code.toUpperCase() === catCode);
  return matchedCat?.group_type === 'RAW_MATERIAL';
}

export function isHeadRiceItem(item: ItemMaster, categories: ProductCategory[] = []): boolean {
  if (isPaddyItem(item, categories)) return false;
  if (item.process_grade === 'SIDDHO' || item.process_grade === 'ATAP') return true;
  const catCode = (item.category || '').toUpperCase();
  if (catCode === 'HEAD_RICE') return true;
  const matchedCat = categories.find((c) => c.code.toUpperCase() === catCode);
  return matchedCat?.group_type === 'FINISHED_GOOD';
}

export function isSaleableRiceOrByproductItem(item: ItemMaster, categories: ProductCategory[] = []): boolean {
  return !isPaddyItem(item, categories);
}
