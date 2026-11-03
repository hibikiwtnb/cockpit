/*
 * Copyright (C) 2018 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import 'cockpit-dark-theme'; // once per page
import '../lib/patternfly/patternfly-6-cockpit.scss';
import 'polyfills'; // once per application

import cockpit from "cockpit";
import * as python from "python";
import hardware_details from "./hardware-details.py";
import React from "react";
import { createRoot } from 'react-dom/client';

import * as timeformat from 'timeformat';

import { Alert, AlertActionCloseButton } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DataList, DataListAction, DataListCell, DataListItem, DataListItemCells, DataListItemRow } from "@patternfly/react-core/dist/esm/components/DataList/index.js";
import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { EmptyState } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { Gallery } from "@patternfly/react-core/dist/esm/layouts/Gallery/index.js";
import { Page, PageBreadcrumb, PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { Content, ContentVariants } from "@patternfly/react-core/dist/esm/components/Content/index.js";
import { Breadcrumb, BreadcrumbItem } from "@patternfly/react-core/dist/esm/components/Breadcrumb/index.js";
import {
    Modal, ModalBody, ModalFooter, ModalHeader
} from '@patternfly/react-core/dist/esm/components/Modal/index.js';
import { Switch } from "@patternfly/react-core/dist/esm/components/Switch/index.js";
import { ExternalLinkAltIcon } from "@patternfly/react-icons";
import { SortByDirection } from "@patternfly/react-table";
import { ListingTable } from "cockpit-components-table.jsx";
import { WithDialogs, useDialogs } from "dialogs.jsx";

import kernelopt_sh from "kernelopt.sh";
import detect from "./hw-detect.js";

import { superuser } from "superuser";
import { PrivilegedButton } from "cockpit-components-privileged";
import { useInit } from "hooks";

import "./hwinfo.scss";

const _ = cockpit.gettext;

const SystemInfo = ({ info }) => {
    if ((!info.name || !info.version) && info.alt_name && info.alt_version) {
        info.name = info.alt_name;
        info.version = info.alt_version;
    }

    const bios_date = Date.parse(info.bios_date); // NaN for undefined, null, or invalid dates

    return (
        <DescriptionList id="hwinfo-system-info-list" className="pf-m-horizontal-on-md">
            { info.type &&
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Type")}</DescriptionListTerm>
                    <DescriptionListDescription>{info.type}</DescriptionListDescription>
                </DescriptionListGroup> }
            { info.name &&
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Name")}</DescriptionListTerm>
                    <DescriptionListDescription>{info.name}</DescriptionListDescription>
                </DescriptionListGroup> }
            { info.version &&
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("Version")}</DescriptionListTerm>
                    <DescriptionListDescription>{info.version}</DescriptionListDescription>
                </DescriptionListGroup> }
            { info.bios_vendor && <>
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("BIOS")}</DescriptionListTerm>
                    <DescriptionListDescription>{info.bios_vendor}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("BIOS version")}</DescriptionListTerm>
                    <DescriptionListDescription>{info.bios_version}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("BIOS date")}</DescriptionListTerm>
                    <DescriptionListDescription>{bios_date ? timeformat.date(bios_date) : info.bios_date}</DescriptionListDescription>
                </DescriptionListGroup>
            </> }
        </DescriptionList>
    );
};

let cachedMitigations;

function availableMitigations() {
    if (cachedMitigations !== undefined)
        return Promise.resolve(cachedMitigations);
    /* nosmt */
    const promises = [cockpit.spawn(["lscpu"], { environ: ["LC_ALL=C.UTF-8"], }), cockpit.file("/proc/cmdline").read()];
    return Promise.all(promises).then(values => {
        let threads_per_core;
        try {
            threads_per_core = Number(values[0].split('\n')
                    .find(l => l.indexOf('Thread(s) per core:') !== -1)
                    .split(':')[1]);
        } catch (e) {
            console.warn(e);
            return { available: false };
        }
        /* "nosmt" and "nosmt=force" are valid */
        const nosmt_enabled = (values[1].indexOf("nosmt") !== -1 && values[1].indexOf("nosmt=") === -1) || values[1].indexOf("nosmt=force") !== -1;
        /* available if threads>1 and the cmdline is valid */
        const nosmt_available = threads_per_core > 1 && (values[1].indexOf("nosmt=") === -1 || values[1].indexOf("nosmt=force") !== -1);
        const mitigations_match = values[1].match(/\bmitigations=(\S*)\b/);

        cachedMitigations = {
            available: nosmt_available,
            nosmt_enabled,
            mitigations_arg: mitigations_match ? mitigations_match[1] : undefined,
        };
        return cachedMitigations;
    });
}

const CPUSecurityMitigationsDialog = () => {
    const [nosmt, setNoSMT] = React.useState(undefined);
    const [alert, setAlert] = React.useState(undefined);
    const [rebooting, setRebooting] = React.useState(false);

    useInit(() => {
        availableMitigations().then(({ available, nosmt_enabled }) => {
            setNoSMT(nosmt_enabled);
        });
    });

    const saveAndReboot = () => {
        let options = [];
        if (nosmt) {
            options = ['set', 'nosmt'];
        } else {
            // this may either be an argument of its own, or part of mitigations=
            const ma = cachedMitigations.mitigations_arg;
            if (ma && ma.indexOf("nosmt") >= 0) {
                const new_args = ma.split(',').filter(opt => opt !== 'nosmt');
                options = ['set', 'mitigations=' + new_args.join(',')];
            } else {
                options = ['remove', 'nosmt'];
            }
        }

        cockpit.script(kernelopt_sh, options, { superuser: "require", err: "message" })
                .then(() => {
                    cockpit.spawn(["shutdown", "--reboot", "now"], { superuser: "require", err: "message" })
                            .catch(error => { setRebooting(false); setAlert(error.message) });
                })
                .catch(error => { setRebooting(false); setAlert(error.message) });
        setRebooting(true);
    };

    const Dialogs = useDialogs();
    const rows = [];
    if (nosmt !== undefined) {
        rows.push(
            <DataListItem key="nosmt">
                <DataListItemRow>
                    <DataListItemCells
                        dataListCells={[
                            <DataListCell key="primary content">
                                <span>
                                    <div className='nosmt-heading'>{ _("Disable simultaneous multithreading") } (nosmt)</div>
                                    <small className='nosmt-read-more-link'>
                                        <a href="https://access.redhat.com/security/vulnerabilities/L1TF" target="_blank" rel="noopener noreferrer">
                                            <ExternalLinkAltIcon /> { _("Read more...") }
                                        </a>
                                    </small>
                                </span>
                            </DataListCell>,
                        ]}
                    />
                    <DataListAction>
                        <div id="nosmt-switch">
                            <Switch isDisabled={rebooting}
                                    onChange={(_event, value) => setNoSMT(value)}
                                    isChecked={nosmt} />
                        </div>
                    </DataListAction>
                </DataListItemRow>
            </DataListItem>
        );
    }

    const footer = (
        <ModalFooter>
            <Button variant='danger' isDisabled={rebooting || nosmt === undefined} onClick={saveAndReboot}>
                { _("Save and reboot") }
            </Button>
            <Button variant='link' className='btn-cancel' isDisabled={rebooting} onClick={Dialogs.close}>
                { _("Cancel") }
            </Button>
        </ModalFooter>
    );

    return (
        <Modal isOpen id="cpu-mitigations-dialog"
               position="top" variant="medium"
               onClose={Dialogs.close}>
            <ModalHeader title={ _("CPU security toggles") } />
            <ModalBody>
                <Content className='cpu-mitigations-dialog-info' component={ContentVariants.p}>
                    { _("Software-based workarounds help prevent CPU security issues. These mitigations have the side effect of reducing performance. Change these settings at your own risk.") }
                </Content>
                <DataList>
                    { rows }
                </DataList>
                { alert !== undefined &&
                <Alert variant="danger"
                    actionClose={<AlertActionCloseButton onClose={() => setAlert(undefined)} />}
                    title={alert} />}
            </ModalBody>
            {footer}
        </Modal>
    );
};

const HardwareSpecs = ({ entries }) =>
    <dl className="hardware-spec-grid">
        {entries.filter(([, value]) => value !== null && value !== undefined && value !== "").map(([label, value]) =>
            <div className="hardware-spec-row" key={label}>
                <dt>{label}</dt><dd>{value}</dd>
            </div>)}
    </dl>;

const mhz = value => value === null || value === undefined ? null : `${Number(value).toFixed(0)} MHz`;
const sensor = (value, unit, precision = 1) => value === null || value === undefined ? null : `${Number(value).toFixed(precision)} ${unit}`;
const bytes = value => value === null || value === undefined ? null : cockpit.format_bytes(value, { base2: true });

const CpuInfo = ({ cpu, system, onSecurityClick }) => {
    const f = cpu.fields || {};
    const dmi = cpu.sockets?.[0] || {};
    const cores = Number(f["Core(s) per socket"]) * Number(f["Socket(s)"]);
    return <>
        <HardwareSpecs entries={[
            [_("Model"), f["Model name"] || system.cpu_model],
            [_("Vendor"), f["Vendor ID"]],
            [_("Architecture"), f.Architecture],
            [_("Sockets"), f["Socket(s)"]],
            [_("CPU cores"), cores || null],
            [_("CPU threads"), f["CPU(s)"] || system.nproc],
            [_("Threads per core"), f["Thread(s) per core"]],
            [_("Base clock"), mhz(cpu.base_mhz)],
            [_("Current clock (CPU 0)"), mhz(cpu.current_mhz)],
            [_("Maximum clock"), mhz(f["CPU max MHz"])],
            [_("Minimum clock"), mhz(f["CPU min MHz"])],
            [_("L1 data cache"), f["L1d cache"]],
            [_("L1 instruction cache"), f["L1i cache"]],
            [_("L2 cache"), f["L2 cache"]],
            [_("L3 cache"), f["L3 cache"]],
            [_("Family / model / stepping"), [f["CPU family"], f.Model, f.Stepping].filter(Boolean).join(" / ")],
            [_("Microcode"), cpu.microcode],
            [_("Virtualization"), f.Virtualization],
            [_("Frequency driver"), cpu.frequency_driver],
            [_("Frequency governor"), cpu.governor],
            [_("Firmware voltage"), dmi.Voltage],
            [_("External clock"), dmi["External Clock"]],
            [_("Socket designation"), dmi["Socket Designation"]],
            [_("Address sizes"), f["Address sizes"]],
        ]} />
        {cpu.temperatures?.length > 0 && <div className="hardware-sensor-strip">
            {cpu.temperatures.map(item => <span key={item.name}>{item.name}: <strong>{sensor(item.temperature, "°C")}</strong></span>)}
        </div>}
        {cpu.flags?.length > 0 && <details className="hardware-extra-details">
            <summary>{_("Instruction sets and capabilities")}</summary>
            <div className="hardware-capabilities">{cpu.flags.map(flag => <code key={flag}>{flag}</code>)}</div>
        </details>}
        {onSecurityClick && <div className="hardware-extra-details">
            <PrivilegedButton variant="link" buttonId="cpu_mitigations" tooltipId="tip-cpu-security"
                excuse={_("The user $0 is not permitted to change cpu security mitigations")}
                onClick={onSecurityClick}>{_("CPU security")}</PrivilegedButton>
        </div>}
    </>;
};

const GpuInfo = ({ gpu }) => {
    const n = gpu.nvidia || {};
    const used = gpu.vram_used !== null && gpu.vram_used !== undefined && gpu.vram_total > 0
        ? `${bytes(gpu.vram_used)} / ${bytes(gpu.vram_total)} (${(100 * gpu.vram_used / gpu.vram_total).toFixed(1)}%)`
        : n.memory_used && n.memory_total ? `${n.memory_used} / ${n.memory_total}` : null;
    return <>
        <HardwareSpecs entries={[
            [_("Model"), n.name || gpu.name],
            [_("Graphics chip"), gpu.chip],
            [_("Vendor"), gpu.vendor],
            [_("Board vendor"), gpu.board_vendor],
            [_("Architecture"), n.architecture],
            [_("GPU processing units"), gpu.compute_units],
            [_("Dedicated graphics memory"), bytes(gpu.vram_total) || n.memory_total],
            [_("Dedicated graphics memory usage"), used],
            [_("Graphics memory accessible to CPU"), bytes(gpu.vram_visible) || n.bar1_total],
            [_("Shared system memory limit"), bytes(gpu.gtt_total)],
            [_("Shared system memory usage"), bytes(gpu.gtt_used)],
            [_("GPU utilization"), sensor(gpu.busy, "%") || n.utilization],
            [_("Graphics memory activity"), sensor(gpu.memory_busy, "%") || n.memory_utilization],
            [_("Core clock"), mhz(gpu.core_mhz) || n.core_clock],
            [_("Maximum core clock"), mhz(gpu.max_core_mhz) || n.max_core_clock],
            [_("Shader clock"), n.sm_clock],
            [_("Memory clock"), mhz(gpu.memory_mhz) || n.memory_clock],
            [_("Maximum memory clock"), n.max_memory_clock],
            [_("Temperature"), sensor(gpu.temperature, "°C") || n.temperature],
            [_("Critical temperature"), sensor(gpu.temperature_critical, "°C") || n.temperature_limit],
            [_("Voltage"), sensor(gpu.voltage, "V", 3)],
            [_("Fan speed"), sensor(gpu.fan_rpm, "RPM", 0) || n.fan],
            [_("Fan control level"), sensor(gpu.fan_pwm, "%")],
            [_("Power draw"), sensor(gpu.power_watts, "W") || n.power_draw],
            [_("Power limit"), sensor(gpu.power_cap_watts, "W") || n.power_limit],
            [_("Graphics card connection speed"), gpu.link_speed && `${gpu.link_speed} ×${gpu.link_width}`],
            [_("Maximum connection speed"), gpu.max_link_speed && `${gpu.max_link_speed} ×${gpu.max_link_width}`],
            [_("PCIe generation"), n.pcie_generation],
            [_("Maximum PCIe generation"), n.pcie_max_generation],
            [_("Hardware location"), gpu.bus],
            [_("Hardware device IDs"), gpu.vendor_id && `${gpu.vendor_id} / ${gpu.device_id}`],
            [_("Board device IDs"), gpu.subsystem_vendor && `${gpu.subsystem_vendor} / ${gpu.subsystem_device}`],
            [_("Revision"), gpu.revision],
            [_("Driver"), gpu.driver],
            [_("Driver version"), n.driver_version],
            [_("Graphics driver interface version"), gpu.drm_version],
            [_("3D graphics library version"), gpu.mesa_dri],
            [_("Display interface library version"), gpu.mesa_egl],
            [_("Radeon driver library version"), gpu.libdrm_radeon],
            [_("Linux kernel version"), gpu.kernel],
            [_("Graphics card firmware"), gpu.vbios || n.vbios],
            [_("Power profile"), gpu.power_profile],
            [_("Performance level"), gpu.performance_level || n.performance_state],
            [_("Supported CUDA version"), n.cuda_version],
            [_("Memory error correction"), n.ecc],
            [_("Graphics card identifier"), n.uuid],
            [_("Serial number"), n.serial],
        ]} />
        {gpu.displays?.length > 0 && <div className="hardware-extra-details hardware-display-ports">
            {gpu.displays.map(port => <details key={port.name}>
                <summary>{port.name} · {port.status === "connected" ? _("Connected") : _("Disconnected")}</summary>
                {port.modes.length > 0 && <p>{_("Supported resolutions")}: {port.modes.join(" · ")}</p>}
            </details>)}
        </div>}
        {gpu.driver_source && <details className="hardware-extra-details">
            <summary>{_("Driver build identifier")}</summary><code>{gpu.driver_source}</code>
        </details>}
    </>;
};

const MemoryInfo = ({ memory, total }) => {
    const modules = memory.filter(dimm => dimm.populated ?? dimm.state !== _("Absent"));
    const sizes = new Map();
    modules.forEach(dimm => sizes.set(dimm.size, (sizes.get(dimm.size) || 0) + 1));
    const configuration = Array.from(sizes, ([size, count]) => `${count} × ${size}`).join(" + ");
    const rank = dimm => dimm.rank === _("Single rank") ? "1R" : dimm.rank === _("Dual rank") ? "2R" : "";

    return <>
        <div className="memory-summary">
            {total > 0 && <strong>{cockpit.format_bytes(total, { base2: true })}</strong>}
            <span>{configuration}</span>
            <span>{cockpit.format(_("$0 / $1 slots used"), modules.length, memory.length)}</span>
        </div>
        <div className="memory-table-scroll" role="region" aria-label={_("Memory modules")}>
            <table className="memory-compact-table">
                <thead>
                    <tr>
                        <th scope="col">{_("Slot")}</th>
                        <th scope="col">{_("Size")}</th>
                        <th scope="col">{_("Type")}</th>
                        <th scope="col">{_("Speed")}</th>
                    </tr>
                </thead>
                <tbody>
                    {memory.map((dimm, index) => {
                        const populated = dimm.populated ?? dimm.state !== _("Absent");
                        return <tr key={dimm.locator + index}>
                            <th scope="row" title={dimm.locator}>{dimm.slot || dimm.locator}</th>
                            {populated
                                ? <>
                                    <td>{dimm.size}</td>
                                    <td title={dimm.technology}>{dimm.type}{rank(dimm) && " · " + rank(dimm)}</td>
                                    <td>{dimm.speed}</td>
                                </>
                                : <td colSpan={3}>{_("Empty")}</td>}
                        </tr>;
                    })}
                </tbody>
            </table>
        </div>
    </>;
};

const HardwareInfo = ({ info }) => {
    const [mitigationsAvailable, setMitigationsAvailable] = React.useState(false);
    const [details, setDetails] = React.useState(info.details);
    const [refreshing, setRefreshing] = React.useState(false);
    const [refreshError, setRefreshError] = React.useState(null);
    const refreshDetails = async () => {
        setRefreshing(true);
        try {
            setDetails(JSON.parse(await python.spawn(hardware_details, [], { superuser: "try", err: "message" })));
            setRefreshError(null);
        } catch (error) {
            setRefreshError(error.message);
        } finally {
            setRefreshing(false);
        }
    };

    useInit(() => {
        availableMitigations().then(({ available }) => setMitigationsAvailable(available));
    });

    const Dialogs = useDialogs();
    let pci = null;
    let memory = null;

    if (info.pci.length > 0) {
        const sortedPci = info.pci.concat();

        pci = (
            <ListingTable aria-label={ _("PCI") }
                sortBy={{ index: 0, direction: SortByDirection.asc }}
                columns={ [
                    { title: _("Class"), sortable: true },
                    { title: _("Model"), sortable: true },
                    { title: _("Vendor"), sortable: true },
                    { title: _("Slot"), sortable: true }
                ] }
                rows={ sortedPci.map(dev => ({
                    props: { key: dev.slot },
                    columns: [dev.cls, dev.model, dev.vendor, dev.slot]
                }))} />
        );
    }

    if (info.memory.length > 0) {
        memory = <MemoryInfo memory={info.memory} total={info.system.memory_installed || info.system.memory} />;
    } else if (!superuser.allowed) {
        memory = (<EmptyState>
            {_("Viewing memory information requires administrative access.")}
        </EmptyState>);
    }

    return (
        <Page className='pf-m-no-sidebar'>
            <PageBreadcrumb hasBodyWrapper={false} stickyOnBreakpoint={{ default: "top" }}>
                <Breadcrumb>
                    <BreadcrumbItem onClick={ () => cockpit.jump("/system", cockpit.transport.host)} className="pf-v6-c-breadcrumb__link">{ _("Overview") }</BreadcrumbItem>
                    <BreadcrumbItem isActive>{ _("Hardware information") }</BreadcrumbItem>
                </Breadcrumb>
            </PageBreadcrumb>
            <PageSection hasBodyWrapper={false}>
                <Gallery hasGutter>
                    <div className="hardware-snapshot-actions">
                        <span>{_("Snapshot")}{details.sampled_at && " · " + timeformat.dateTime(details.sampled_at * 1000)}</span>
                        <Button variant="secondary" isLoading={refreshing} isDisabled={refreshing} onClick={refreshDetails}>{_("Refresh")}</Button>
                    </div>
                    {refreshError && <Alert isInline variant="warning" title={_("Failed to refresh hardware information")}>{refreshError}</Alert>}
                    <Card isPlain id="cpu-information">
                        <CardHeader><CardTitle component="h2">{_("CPU")}</CardTitle></CardHeader>
                        <CardBody>
                            <CpuInfo cpu={details.cpu || {}} system={info.system}
                                onSecurityClick={mitigationsAvailable ? () => Dialogs.show(<CPUSecurityMitigationsDialog />) : undefined} />
                        </CardBody>
                    </Card>
                    <Card isPlain id="memory-listing">
                        <CardHeader>
                            <CardTitle component="h2">{_("Memory")}</CardTitle>
                        </CardHeader>
                        <CardBody className="contains-list">
                            { memory }
                        </CardBody>
                    </Card>
                    {(details.gpus || info.graphics.map(gpu => ({ name: gpu.model, vendor: gpu.vendor, bus: gpu.slot }))).map((gpu, index) =>
                        <Card isPlain key={gpu.bus} id={"gpu-information-" + index}>
                            <CardHeader><CardTitle component="h2">GPU {index} · {gpu.name}</CardTitle></CardHeader>
                            <CardBody><GpuInfo gpu={gpu} /></CardBody>
                        </Card>)}
                    <Card isPlain id="storage-information">
                        <CardHeader><CardTitle component="h2">{_("Storage")}</CardTitle></CardHeader>
                        <CardBody>
                            <HardwareSpecs entries={info.disks.map(disk => ["/dev/" + disk.name,
                                `${disk.model?.trim() || disk.name} · ${bytes(Number(disk.size))}${disk.tran ? " · " + disk.tran.toUpperCase() : ""}`])} />
                        </CardBody>
                    </Card>
                    <Card isPlain>
                        <CardHeader><CardTitle component="h2">{_("System information")}</CardTitle></CardHeader>
                        <CardBody><SystemInfo info={info.system} /></CardBody>
                    </Card>
                    <Card isPlain id="pci-listing">
                        <CardHeader>
                            <CardTitle component="h2">{_("PCI")}</CardTitle>
                        </CardHeader>
                        <CardBody className="contains-list">
                            { pci }
                        </CardBody>
                    </Card>
                </Gallery>
            </PageSection>
        </Page>
    );
};

document.addEventListener("DOMContentLoaded", () => {
    document.title = cockpit.gettext(document.title);
    detect().then(info => {
        const root = createRoot(document.getElementById('hwinfo'));
        root.render(<WithDialogs><HardwareInfo info={info} /></WithDialogs>);
    });
});
