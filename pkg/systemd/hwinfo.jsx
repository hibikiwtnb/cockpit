/*
 * Copyright (C) 2018 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import 'cockpit-dark-theme'; // once per page
import '../lib/patternfly/patternfly-6-cockpit.scss';
import 'polyfills'; // once per application

import cockpit from "cockpit";
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

const SystemInfo = ({ info, graphics, disks, onSecurityClick }) => {
    if ((!info.name || !info.version) && info.alt_name && info.alt_version) {
        info.name = info.alt_name;
        info.version = info.alt_version;
    }

    const mitigations = (
        <PrivilegedButton variant="link" buttonId="cpu_mitigations" tooltipId="tip-cpu-security"
                    excuse={ _("The user $0 is not permitted to change cpu security mitigations") }
                    onClick={ onSecurityClick }>
            { _("Mitigations") }
        </PrivilegedButton>
    );

    const bios_date = Date.parse(info.bios_date); // NaN for undefined, null, or invalid dates

    return (
        <DescriptionList id="hwinfo-system-info-list" className="pf-m-horizontal-on-md">
            { info.nproc !== undefined &&
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("CPU")}</DescriptionListTerm>
                    <DescriptionListDescription>
                        {info.cpu_model} ({cockpit.format(cockpit.ngettext("$0 logical processor", "$0 logical processors", info.nproc), info.nproc)})
                    </DescriptionListDescription>
                </DescriptionListGroup> }
            <DescriptionListGroup>
                <DescriptionListTerm>{_("Memory")}</DescriptionListTerm>
                <DescriptionListDescription>
                    {info.memory_installed || info.memory
                        ? cockpit.format_bytes(info.memory_installed || info.memory, { base2: true })
                        : _("Unknown")}
                </DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
                <DescriptionListTerm>{_("GPU")}</DescriptionListTerm>
                <DescriptionListDescription>
                    {graphics.length > 0 ? graphics.map(gpu => <div key={gpu.slot}>{gpu.model}</div>) : _("Unknown")}
                </DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
                <DescriptionListTerm>{_("Storage")}</DescriptionListTerm>
                <DescriptionListDescription>
                    {disks.length > 0
                        ? disks.map(disk => <div key={disk.name}>
                            {disk.model?.trim() || disk.name} — {cockpit.format_bytes(Number(disk.size), { base2: true })} ({"/dev/" + disk.name})
                        </div>)
                        : _("Unknown")}
                </DescriptionListDescription>
            </DescriptionListGroup>
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
            { onSecurityClick !== undefined &&
                <DescriptionListGroup>
                    <DescriptionListTerm>{_("CPU security")}</DescriptionListTerm>
                    <DescriptionListDescription>{mitigations}</DescriptionListDescription>
                </DescriptionListGroup> }
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
                    <Card isPlain>
                        <CardHeader>
                            <CardTitle component="h2">{_("System information")}</CardTitle>
                        </CardHeader>
                        <CardBody>
                            <SystemInfo info={info.system}
                                        graphics={info.graphics}
                                        disks={info.disks}
                                        onSecurityClick={mitigationsAvailable
                                            ? () => Dialogs.show(<CPUSecurityMitigationsDialog />)
                                            : undefined } />
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
