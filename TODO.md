[x] If possible, pipelines should be created using the async functions
    and the other work should happen (generating the city?) so that hopefully
    the pipelines are done in parallel.
[x] Generating the world and Compiling Shaders should show some kind of progress
[x] Please add a gzip size during build that shows the sum of the size of the
    gzipped files for index.html, main.js, audio-renderer.js. On the github
    action "production" build, minimize/tersify the JS.
[x] The orbit camera should pick up where it is then the user interrupts the
    auto camera (unless it's inside the vehicle). As it is it snaps away
[x] Make C change the camera like the camera button.
[x] remove the hiss/rain from the audio
[ ] there are several places where signs z-fight with buildings or 2 signs are stacked
    on top of each other and are z-fighting