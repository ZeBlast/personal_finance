-- The dashboard grid became twice as fine (24 columns and 30px rows instead of 12 and 60), so
-- widgets can be placed and resized in half steps. Saved positions and sizes are doubled, so every
-- dashboard looks exactly as before.
UPDATE `dashboard_widgets` SET `x` = `x` * 2, `y` = `y` * 2, `w` = `w` * 2, `h` = `h` * 2;