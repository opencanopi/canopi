// geolocation-only-in-geolocation-module: a call by bracket access, through a non-null assertion.
declare const geo: Geolocation | undefined
geo!['clearWatch'](3)
