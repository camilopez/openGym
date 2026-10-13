# The fork's frontend on top of the released web image (homelab/deploy-web.sh builds it).
# Only the app changes: nginx, its config template and the exercise media are the release's, so
# this is the official image with the fork's static files and nothing else. The frontend is built
# on the Mac and shipped here as dist/: the 1 GB LXC has no room for a Node build, and the
# static output does not depend on the architecture.
ARG BASE
FROM ${BASE}
USER root
# Old hashed bundles would linger next to the new ones, so the app tree is replaced, not merged.
RUN find /usr/share/nginx/html -mindepth 1 -maxdepth 1 ! -name exercise-media ! -name 50x.html -exec rm -rf {} +
COPY dist/ /usr/share/nginx/html/
USER 101
ARG VCS_REF=dev
LABEL org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.source="https://github.com/camilopez/openGym"
