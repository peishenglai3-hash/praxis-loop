import { readFileSync, statSync } from 'node:fs';

/** This checks the provisioning record and virtualization hints, not sandbox security. */
export function assertSandbox({ allowRoot = false } = {}) {
  if (process.platform === 'win32') {
    const jobName = process.env.PRAXIS_LOOP_JOB_NAME;
    const appContainerSid = process.env.PRAXIS_LOOP_APPCONTAINER_SID;
    if (process.env.PRAXIS_LOOP_SANDBOX_VERIFIED !== '1' ||
        process.env.PRAXIS_LOOP_APPCONTAINER_VERIFIED !== '1' ||
        process.env.PRAXIS_LOOP_JOB_OBJECT_VERIFIED !== '1' ||
        !appContainerSid || !/^S-1-15-2-/u.test(appContainerSid) || !jobName ||
        process.env.PRAXIS_LOOP_NO_NETWORK_CAPABILITIES !== '1') {
      throw new Error('Windows tests require the guarded AppContainer launcher with an empty network capability set.');
    }
    return { schemaVersion: 1, isolation: 'windows-appcontainer', appContainerSid,
      noNetworkCapabilities: true, jobObject: true,
      product: 'Windows AppContainer', virtualizationEvidence: [] };
  }
  if (process.platform !== 'linux') throw new Error('Tests require an approved Linux VM or the verified Windows AppContainer launcher. Host execution is prohibited.');
  const marker = '/etc/praxis-loop-test-sandbox.json';
  const stat = statSync(marker);
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error('Sandbox record must be root-owned and not writable by group/others');
  const record = JSON.parse(readFileSync(marker, 'utf8'));
  if (record.schemaVersion !== 1 || record.dedicatedVm !== true || record.noHostMounts !== true || record.networkRestricted !== true) {
    throw new Error('Sandbox provisioning record is incomplete');
  }
  // The CI host sets this only after validating the hosted runner and Docker
  // configuration; containers do not expose the guest's DMI virtualization flags.
  const dockerWrapperVerified = process.env.PRAXIS_LOOP_DOCKER_ISOLATION_VERIFIED === '1';
  const optionalText = (path) => {
    try { return readFileSync(path, 'utf8').trim(); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'EACCES') return ''; throw error; }
  };
  if (process.env.WSL_DISTRO_NAME || /microsoft/iu.test(optionalText('/proc/version'))) {
    throw new Error('WSL is not an accepted dedicated test VM');
  }
  const product = optionalText('/sys/class/dmi/id/product_name');
  // Some KVM guests report only "Standard PC" in DMI. Require affirmative
  // virtualization evidence from DMI, CPU flags or the hypervisor sysfs entry.
  const cpuHypervisor = /^(?:flags|features)\s*:.*\bhypervisor\b/imu.test(optionalText('/proc/cpuinfo'));
  const hypervisorType = optionalText('/sys/hypervisor/type');
  const virtualizationEvidence = [
    /virtual|kvm|qemu|vmware|hvm|bochs/i.test(product) ? 'dmi' : null,
    cpuHypervisor ? 'cpu-hypervisor-flag' : null,
    /^(?:xen|kvm|qemu|vmware|hyperv|microsoft|bhyve)$/iu.test(hypervisorType) ? 'hypervisor-sysfs' : null,
  ].filter(Boolean);
  if (virtualizationEvidence.length === 0 && !dockerWrapperVerified) {
    throw new Error(`Not a recognized VM: ${product || '(DMI unavailable)'}`);
  }
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8');
  if (/ - (9p|virtiofs|vboxsf|fuse\.vmhgfs-fuse) /u.test(mounts)) throw new Error('Host filesystem sharing is prohibited');
  if (!allowRoot && process.getuid() === 0) throw new Error('Mechanism tests must run as an unprivileged guest user');
  return {
    ...record,
    isolation: dockerWrapperVerified ? 'github-hosted-vm+hardened-container' : 'dedicated-linux-vm',
    product,
    virtualizationEvidence: dockerWrapperVerified
      ? ['github-hosted-runner', 'docker-inspect-network-none-no-host-mounts']
      : virtualizationEvidence,
  };
}
