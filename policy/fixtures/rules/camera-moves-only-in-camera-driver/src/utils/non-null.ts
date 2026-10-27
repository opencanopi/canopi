// camera-moves-only-in-camera-driver: a camera move through a non-null callee.
declare const map: { flyTo?(options: object): void }
map.flyTo!({ zoom: 3 })
