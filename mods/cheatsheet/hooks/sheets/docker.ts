import type { Sheet } from '../sheet'

export const docker: Sheet = {
  topic: 'docker',
  title: 'Docker',
  aliases: ['compose'],
  summary: 'images, containers, volumes, compose, cleanup',
  markdown: `## Images
    docker build -t name:tag .   build an image from the Dockerfile here
    docker images                list images
    docker pull image:tag        download an image
    docker tag <src> <name:tag>  give an image another name
    docker push name:tag         upload an image to a registry
    docker rmi <image>           remove an image
    docker history <image>       layers of an image and their sizes

## Run containers
    docker run -d --name web -p 8080:80 nginx    detached, named, host port 8080 to container port 80
    docker run --rm -it ubuntu bash              interactive shell, container removed on exit
    docker run -e KEY=value <image>              set an environment variable (--env-file .env for many)
    docker run -v "$PWD":/app -w /app <image>    bind-mount the current directory and work in it
    docker run -v data:/var/lib/data <image>     named volume
    docker run --network <net> <image>           join a network
    docker run --restart unless-stopped <image>  restart policy

## Manage containers
    docker ps -a                       list containers, stopped ones too
    docker stop | start | restart <c>  control a container
    docker rm -f <c>                   remove a container (-f stops it first)
    docker logs -f --tail 100 <c>      follow the last 100 log lines
    docker exec -it <c> sh             open a shell in a running container
    docker cp <c>:/path ./local        copy files out of (or into) a container
    docker inspect <c>                 full JSON details
    docker stats                       live CPU and memory per container

## Volumes and networks
    docker volume ls | create | rm        manage named volumes
    docker volume prune                   remove volumes no container uses
    docker network ls | create | inspect  manage networks

## Compose
    docker compose up -d                     create and start the services in the background
    docker compose down                      stop and remove them (-v also removes volumes)
    docker compose ps                        service status
    docker compose logs -f [service]         follow logs
    docker compose exec <service> sh         shell in a running service
    docker compose run --rm <service> <cmd>  one-off command in a new container
    docker compose build --no-cache          rebuild images from scratch
    docker compose config                    print the merged, resolved configuration

## Clean up
    docker system df                  disk used by images, containers and volumes
    docker system prune               remove stopped containers, dangling images, unused networks
    docker system prune -a --volumes  also remove every unused image and volume (destructive)
    docker container prune            remove stopped containers only

## Dockerfile
    FROM node:22-slim AS build          base image; AS names a build stage
    WORKDIR /app                        working directory for the next instructions
    COPY package*.json ./               copy files in (copy dependency files first for layer caching)
    RUN npm ci                          run a command while building
    ENV NODE_ENV=production             environment variable
    EXPOSE 3000                         document the listening port
    COPY --from=build /app/dist ./dist  multi-stage: take files from an earlier stage
    CMD ["node", "server.js"]           default command (ENTRYPOINT sets the fixed executable)
    .dockerignore                       files kept out of the build context (node_modules, .git)
`,
}
