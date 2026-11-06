# LMS Automator Pro

A full-fledged Web Dashboard for managing LMS video sessions. It allows you to run multiple videos simultaneously in isolated environments so they don't pause each other, and provides a real-time Live View feed of the headless browser.

## Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Initial Login**
   Since the bot needs your session to access videos, run the setup script once:
   ```bash
   npm run setup
   ```
   A browser will open. Log in to the LMS and press ENTER in the terminal. Your session will be saved locally.

## Running the Dashboard

1. Start the server:
   ```bash
   npm start
   ```
2. Open your browser to `http://localhost:3000`.
3. Add video URLs and their duration directly from the UI!

## Features

- **Isolated Sessions:** Each video you add runs in its own incognito browser context. This prevents the LMS from pausing one video when another starts.
- **Live View Stream:** Curious if the video is actually playing? Click the "View Live" button to get a real-time screenshot stream from the headless browser without interrupting it.
- **Progress Tracking:** See live progress bars for all your active sessions.
- **Background Autoplay:** The bot automatically clicks the video (even YouTube iframes) to ensure playback starts.

<!---LeetCode Topics Start-->
# LeetCode Topics
## Array
|  |
| ------- |
| [1385-find-the-distance-value-between-two-arrays](https://github.com/iamsachinaryan/lms-automation/tree/master/1385-find-the-distance-value-between-two-arrays) |
## Two Pointers
|  |
| ------- |
| [1385-find-the-distance-value-between-two-arrays](https://github.com/iamsachinaryan/lms-automation/tree/master/1385-find-the-distance-value-between-two-arrays) |
## Binary Search
|  |
| ------- |
| [1385-find-the-distance-value-between-two-arrays](https://github.com/iamsachinaryan/lms-automation/tree/master/1385-find-the-distance-value-between-two-arrays) |
## Sorting
|  |
| ------- |
| [1385-find-the-distance-value-between-two-arrays](https://github.com/iamsachinaryan/lms-automation/tree/master/1385-find-the-distance-value-between-two-arrays) |
<!---LeetCode Topics End-->