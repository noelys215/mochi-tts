# Phase 10 manual verification

1. Open a LeetCode learning article and enable **Passage hover controls** for that tab.
2. Hover prose, inline code, and math; confirm one passage button follows the paragraph.
3. Hover a full code block; confirm no passage action appears.
4. Hover the lesson title, open **Read this page**, and confirm navigation, Report Issue, and full code are excluded.
5. Start a passage, switch tabs, and confirm audio continues without showing the player in the other tab.
6. Return to the owner tab and confirm its player remains synchronized.
7. Start playback in a second enabled tab and confirm it replaces the first session.
8. Close a non-owner tab and confirm playback continues; close the owner and confirm playback stops.
9. On an iframe-hosted lesson, select the lesson iframe in DevTools and confirm the content controller is present there.
10. Confirm passage and **Read this page** actions appear inside the lesson frame, while the navigation shell and code blocks remain ignored.
11. Start a passage and confirm the player appears only inside the lesson frame.
12. Navigate to another lesson and confirm the old frame controls disappear and the new lesson initializes once.
