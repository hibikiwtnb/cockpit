/*
 * Copyright (C) 2019 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardFooter, CardTitle } from "@patternfly/react-core/dist/esm/components/Card/index.js";

import cockpit from "cockpit";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { ExclamationCircleIcon } from "@patternfly/react-icons";
import { PageStatusNotifications } from "../page-status.jsx";
import { ShutDownStatus } from "./shutdownStatus.jsx";
import { UncleanShutdownStatus } from "./uncleanShutdownStatus.jsx";
import LastLogin from "./lastLogin.jsx";

import "./healthCard.scss";
import { SmartOverviewStatus } from './smart-status.jsx';

const _ = cockpit.gettext;

const FailedServicesStatus = () => {
    const [failed, setFailed] = useState(0);

    useEffect(() => {
        const client = cockpit.dbus("org.freedesktop.systemd1");
        const path = "/org/freedesktop/systemd1";
        const manager = "org.freedesktop.systemd1.Manager";
        let active = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const refresh = () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                client.call(path, manager, "ListUnitsFiltered", [["failed"]])
                        .then(([units]) => {
                            if (active)
                                setFailed((units as unknown[]).length);
                        })
                        .catch(error => console.warn("Failed to read failed units:", error));
            }, 200);
        };
        client.subscribe({ interface: manager, path }, (_path, _iface, signal) => {
            if (["JobRemoved", "UnitNew", "UnitRemoved"].includes(signal))
                refresh();
        });
        client.subscribe({ interface: "org.freedesktop.DBus.Properties" }, (_path, _iface, _signal, args) => {
            if (args[0] === "org.freedesktop.systemd1.Unit" && args[1] && typeof args[1] === "object" && "ActiveState" in args[1])
                refresh();
        });
        client.call(path, manager, "Subscribe", []).then(refresh)
                .catch(error => console.warn("Failed to subscribe to systemd:", error));
        return () => {
            active = false;
            window.clearTimeout(timer);
            client.close();
        };
    }, []);

    if (!failed)
        return null;

    return <li className="system-health-failed-services">
        <ExclamationCircleIcon />{" "}
        <Button isInline variant="link" onClick={() => cockpit.jump("/system/services")}>
            {cockpit.format(cockpit.ngettext("$0 failed unit", "$0 failed units", failed), failed)}
        </Button>
    </li>;
};

export const HealthCard = () =>
    <Card className="system-health">
        <CardTitle>{_("Health")}</CardTitle>
        <CardBody>
            <ul className="system-health-events">
                <PageStatusNotifications />
                <FailedServicesStatus />
                <ShutDownStatus />
                <UncleanShutdownStatus />
                <SmartOverviewStatus />
                <LastLogin />
            </ul>
        </CardBody>
        <CardFooter />
    </Card>;
