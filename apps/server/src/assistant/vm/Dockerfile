FROM python@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258
RUN apt-get update && apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils openssh-client cloud-image-utils curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/t3-vm /home/t3vm && useradd -m -d /home/t3vm -u 1000 -s /bin/sh t3vm && chown t3vm:t3vm /home/t3vm
RUN curl -fL --retry 3 -o /opt/t3-vm/ubuntu.qcow2 https://cloud-images.ubuntu.com/noble/20261017/noble-server-cloudimg-amd64.img && echo '04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94  /opt/t3-vm/ubuntu.qcow2' | sha256sum -c -
COPY --chmod=0555 start.sh exec.sh /opt/t3-vm/
USER 1000:1000
WORKDIR /home/t3vm
ENTRYPOINT ["/opt/t3-vm/start.sh"]
