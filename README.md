# Virtual Studio 🎵

Virtual Studio is a fully featured, browser-based multi-track Web Audio synthesizer, step sequencer, and orchestral engine[cite: 8]. It allows users to create, edit, and play back multi-instrument musical compositions directly in the browser with zero external dependencies[cite: 8, 10].

![alt text](app.png)

## ✨ Key Features

* **Multi-Instrument Tracks & Orchestral Suite**: Includes standard core instruments (Drum kit, Digital piano, Electric guitar, Bass guitar) alongside a rich orchestral and brass selection featuring Trumpet, Trombone, Clarinet, Flute, Violin, Cello, and Saxophone[cite: 8].
* **Advanced Piano Roll Editor**: An interactive grid supporting both straight and triplet note durations (ranging from 1/16 notes up to full 1-bar triplets)[cite: 6, 8, 10].
* **Built-in Genre Presets**: Instantly load professionally arranged musical patterns for genres like Rock, Hip-hop, House, Funk, Reggae, and Pop ballad[cite: 8].
* **Audio Lab & Stem Extraction**: Upload custom MP3 or WAV audio files to generate approximate frequency-filtered audio stems (drums, piano, guitar) for your workspace[cite: 8].
* **Real-time Transport Controls**: Fully functional Play, Pause, Stop, Loop toggle, adjustable tempo (BPM), master volume control, and a real-time LCD playhead tracking bars and beats[cite: 6, 8, 10].
* **Responsive Design & Theming**: Built with automatic light and dark mode support, fluid layout wrappers, and mobile-friendly channel strips[cite: 6, 8, 9].

## 📁 Project Structure

The codebase is organized into clean, modular files:
* `index.html`: Application HTML markup, UI containers, and layout structure[cite: 10].
* `styles.css`: CSS style definitions, theme color variables, and responsive media queries[cite: 9].
* `app.js`: Web Audio API synthesis engine, sound scheduling, track state, and UI event listeners[cite: 8].

## 🚀 Getting Started

1. Clone or download this repository to your local machine.
2. Verify that `index.html`, `styles.css`, and `app.js` are in the same folder[cite: 10].
3. Open `index.html` in any modern web browser that supports the Web Audio API.

## ⌨️ Controls & Shortcuts

* **Spacebar**: Toggle play and pause[cite: 6, 10].
* **Grid Editing**: Click or drag across grid cells to place or remove notes[cite: 6, 10].
* **Sound Preview**: Click any instrument row label on the left sidebar to audition the sound[cite: 6, 10].