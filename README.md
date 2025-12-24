# X06 Tonfolgen-Decoder v4

Neu in v4:
- Anzeige der gemessenen Frequenz (Hz) + Stärke neben der erkannten Ziffer
- Bessere Erkennung durch "per-tone window scoring" (nicht nur globaler Peak)
- Quadratische Interpolation um Peak-Bin (stabilere Frequenzschätzung)
- Gate (MIN_STRENGTH) als Slider
- Optional FFT 8192 (mehr Frequenzauflösung)

## Tipps zur Verbesserung
- Wenn falsche Ziffern: Gate erhöhen (z.B. 190–210)
- Wenn Frequenz daneben (z.B. 1 wird als 2 erkannt): FFT 8192 aktivieren
- Waterfall ist ideal zum Debuggen: du solltest 6 klare horizontale Linien sehen.

Start lokal:
python -m http.server 8000
