export const safeName = (name: string) => name.replace(/[<>:"/\\|?*]/g, '_')
