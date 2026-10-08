# Cyber Web City

Make a Blade Runner inspired flying car in a futuristic city in WebGPU
with no libraries. Use the latest typescript, esbuild, gts the work together
and have a github action to publish on github pages. Use WebGPU best practices.

The world, cars, and car interior, should all be procedurally generated.
The idea is simulate a relaxing fly through the city.

For the city, take inspiration from Blade Runner, Dredd, Judge Dredd, the city part
of The Fifth Element, Cyberpunk 2077. The city should appear enormous. Buildings are
much taller than today. There should be enormous displays with giant
animated advertisements. These can be generated from 3d scenes, rendered
to a texture, then used on the displays. There should be advertising holograms as large
as buildings.

Also take inspiration from modern cities in China like Chongqing, Shenzhen, and Shanghai.
In particular, interesting building designs and gaudy lighting

For the car, take inspiration from Blade Runner. The car should have a transparent
top so the passengers can view in all directions. The scene should be night time
and raining with the camera having a chase mode and an inside the car, drivers
POV mode. The drivers POV should show condensation on the windows. Use NURBS to make
the car. Consider making a NURBS api and give it to another agent to design the car
and a 3rd agent to judge.

It should look amazing! Like a blockbuster sci-fi movie.
It should use techniques from AAA games to both look amazing and to keep the frame rate up.
Consider using techniques like those from Unreal Nanite, if appropriate. Games like
Ratchet and Clank, Spiderman, GTA5, Cyberpunk 2027 all manage to draw very large detailed
cities and keep a good framerate. Render no more than CSS resolution, no devicePixelRatio
adjustment for now.

The project can be tested with puppeteer, no special arguments are needed. If serving
the page use express for local testing. Be sure to label all WebGPU objects,
and print webgpu uncapturederror events so that you will know when WebGPU has failed
and from the labels, be able to figure out where the issue is.

Have at least one agent who's sole duty is to judge if the result matches AAA
games.
