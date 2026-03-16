# Chatty Voice Agent

A small Node.js app that opens a local website for real-time voice chat.

- Speech-to-text runs in the browser with MoonshineJS.
- The assistant reply is generated with the OpenAI Chat Completions API.
- Text-to-speech uses the OpenAI speech API and plays the answer back in the browser.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the env template and add your API key:

   ```bash
   cp .env.example .env
   ```

3. Start the server:

   ```bash
   npm run dev
   ```

4. Open `http://localhost:3005`.

## Notes

- The first mic start can take a few seconds while MoonshineJS downloads and initializes its STT model in the browser.
- The app uses Moonshine's streaming mode, so you get live transcript updates while speaking and a committed transcript after you pause.
- If you want shorter or longer answers, change `SYSTEM_PROMPT` in `.env`.
