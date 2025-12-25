# X06 Tone Sequence Decoder (Web)

Browserbasierter Live-Decoder für 6-Ton-Sequenzen (1–6) mit Spektrum- und Waterfall-Anzeige, Mikrofon-Eingang, integrierter Day/Night-Datenbank und Test-Signal-Generator.
Das Projekt läuft vollständig im Browser (Web Audio API) und ist für GitHub Pages geeignet.

![Screenshot der Web-App](screenshot.png)

## Live-Demo (GitHub Pages)

https://jan-niklas-schneider.github.io/x06-decoder/

## Features

### Audio und Decoder
- Auswahl des Audio-Inputs (Mikrofon oder virtuelles Audiokabel)
- Live-Decoding von 6-Ton-Sequenzen (Ziffern 1 bis 6)
- Robuste Erkennung durch FFT-Analyse mit Fenster-Scoring
- Frequenzbasierte Zuordnung (Hz zu Ziffer)
- Anzeige der erkannten Ziffer, Frequenz, Signalstärke und laufenden Sequenz

### Visualisierung
- Live-Spektrum mit beschrifteter Frequenzachse (Hz)
- Marker für alle Sollfrequenzen (1–6)
- Marker für aktuell erkannte Frequenz
- Waterfall-Plot (Spektrogramm) zur zeitlichen Darstellung der Tonfolge

### Test-Signal-Generator
- Abspielen beliebiger Sequenzen (z. B. 123456)
- Einstellbare Tonlänge, Pause und Lautstärke
- Loop-Funktion
- Geeignet für Offline- und Entwicklungstests

## Nutzung

### Seite öffnen
Öffne die GitHub-Pages-URL im Browser (Chrome oder Edge empfohlen).

### Mikrofon starten
- Audio-Input auswählen
- Start klicken
- Mikrofonzugriff erlauben

### Decodieren
- 6-Ton-Sequenz abspielen
- Spektrum und Waterfall beobachten
- Nach sechs erkannten Ziffern wird das Target automatisch aufgelöst

### Datenbank
- Suche nach Sequenz oder Target
- Erkannte Targets werden automatisch markiert
- Klick auf einen Eintrag übernimmt die Sequenz in den Generator

### Test-Signal-Generator
- Sequenz eingeben (nur Ziffern 1–6, Länge 6)
- Play klicken
- Optional Loop aktivieren

## Lokale Entwicklung

```bash
git clone https://github.com/jan-niklas-schneider/x06-decoder.git
cd x06-decoder
python -m http.server 8000
```

Anschließend im Browser öffnen:
http://localhost:8000

## Hinweise

- Echo Cancellation, Noise Suppression und Auto Gain Control deaktivieren
- Ruhige Umgebung verwenden
- Direktes Einspeisen ist stabiler als Lautsprecher-zu-Mikrofon

## Lizenz

MIT License.
