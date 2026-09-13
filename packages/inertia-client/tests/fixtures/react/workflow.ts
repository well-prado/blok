/**
 * Stands in for a Blok workflow module whose `definePage` export carries its
 * prop type on a phantom `__props` field — the monorepo path that lets a page
 * component import the type directly instead of going through `Pages`.
 */
declare const ordersShow: { __props: { order: { id: string; total: number } } };
export default ordersShow;
