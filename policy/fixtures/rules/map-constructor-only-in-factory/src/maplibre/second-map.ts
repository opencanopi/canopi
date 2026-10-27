declare const maplibre: { Map: new (o: object) => object }
export const map = new maplibre.Map({ container: 'planted' })
