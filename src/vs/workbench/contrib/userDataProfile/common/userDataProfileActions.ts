/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from 'vs/base/common/cancellation';
import { DisposableStore } from 'vs/base/common/lifecycle';
import { joinPath } from 'vs/base/common/resources';
import { localize } from 'vs/nls';
import { Action2, registerAction2 } from 'vs/platform/actions/common/actions';
import { IFileDialogService } from 'vs/platform/dialogs/common/dialogs';
import { IFileService } from 'vs/platform/files/common/files';
import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IQuickInputService, IQuickPickItem } from 'vs/platform/quickinput/common/quickInput';
import { asJson, asText, IRequestService } from 'vs/platform/request/common/request';
import { IUserDataProfileTemplate, isProfile, IUserDataProfileManagementService, IUserDataProfileWorkbenchService, PROFILES_CATEGORY, PROFILE_EXTENSION, PROFILE_FILTER } from 'vs/workbench/services/userDataProfile/common/userDataProfile';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { IUserDataProfilesService } from 'vs/platform/userDataProfile/common/userDataProfile';
import { IsDevelopmentContext } from 'vs/platform/contextkey/common/contextkeys';
import { ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { WorkbenchStateContext } from 'vs/workbench/common/contextkeys';
import { CATEGORIES } from 'vs/workbench/common/actions';
import { IUriIdentityService } from 'vs/platform/uriIdentity/common/uriIdentity';

registerAction2(class SaveProfileAsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.profiles.actions.saveProfileAs',
			title: {
				value: localize('save profile as', "Save Settings Profile As..."),
				original: 'Save Settings Profile As...'
			},
			category: PROFILES_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.and(IsDevelopmentContext, WorkbenchStateContext.notEqualsTo('empty')),
		});
	}

	async run(accessor: ServicesAccessor) {
		const quickInputService = accessor.get(IQuickInputService);
		const userDataProfileManagementService = accessor.get(IUserDataProfileManagementService);
		const name = await quickInputService.input({
			placeHolder: localize('name', "Profile name"),
			title: localize('save profile as', "Save Settings Profile As..."),
		});
		if (name) {
			await userDataProfileManagementService.createAndEnterProfile(name, undefined, true);
		}
	}
});

registerAction2(class SwitchProfileAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.profiles.actions.switchProfile',
			title: {
				value: localize('switch profile', "Switch Settings Profile"),
				original: 'Switch Settings Profile'
			},
			category: PROFILES_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.and(IsDevelopmentContext, WorkbenchStateContext.notEqualsTo('empty')),
		});
	}

	async run(accessor: ServicesAccessor) {
		const quickInputService = accessor.get(IQuickInputService);
		const userDataProfilesService = accessor.get(IUserDataProfilesService);
		const userDataProfileManagementService = accessor.get(IUserDataProfileManagementService);

		const profiles = await userDataProfilesService.getAllProfiles();
		if (profiles.length) {
			const picks: IQuickPickItem[] = profiles.map(p => ({
				label: p.name!,
				description: p.name === userDataProfilesService.currentProfile.name ? localize('current', "Current") : undefined,
			}));
			const pick = await quickInputService.pick(picks, { placeHolder: localize('pick profile', "Select Settings Profile") });
			if (pick) {
				await userDataProfileManagementService.switchProfile(pick.label);
			}
		}
	}
});

registerAction2(class RemoveProfileAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.profiles.actions.removeProfile',
			title: {
				value: localize('remove profile', "Remove Settings Profile"),
				original: 'Remove Settings Profile'
			},
			category: PROFILES_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.and(IsDevelopmentContext, WorkbenchStateContext.notEqualsTo('empty')),
		});
	}

	async run(accessor: ServicesAccessor) {
		const quickInputService = accessor.get(IQuickInputService);
		const userDataProfilesService = accessor.get(IUserDataProfilesService);
		const userDataProfileManagementService = accessor.get(IUserDataProfileManagementService);

		const profiles = (await userDataProfilesService.getAllProfiles()).filter(p => p.name !== userDataProfilesService.currentProfile.name && p.name !== userDataProfilesService.defaultProfile.name);
		if (profiles.length) {
			const pick = await quickInputService.pick(profiles.map(p => ({ label: p.name! })), { placeHolder: localize('pick profile', "Select Settings Profile") });
			if (pick) {
				await userDataProfileManagementService.removeProfile(pick.label);
			}
		}
	}
});

registerAction2(class CleanupProfilesAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.profiles.actions.cleanupProfiles',
			title: {
				value: localize('cleanup profile', "Cleanup Profiles"),
				original: 'Cleanup Profiles'
			},
			category: CATEGORIES.Developer,
			f1: true,
			precondition: IsDevelopmentContext,
		});
	}

	async run(accessor: ServicesAccessor) {
		const userDataProfilesService = accessor.get(IUserDataProfilesService);
		const fileService = accessor.get(IFileService);
		const uriIdentityService = accessor.get(IUriIdentityService);

		const allProfiles = await userDataProfilesService.getAllProfiles();
		const stat = await fileService.resolve(userDataProfilesService.profilesHome);
		await Promise.all((stat.children || [])?.filter(child => child.isDirectory && allProfiles.every(p => !uriIdentityService.extUri.isEqual(p.location, child.resource)))
			.map(child => fileService.del(child.resource, { recursive: true })));
	}
});

registerAction2(class CreateAndEnterEmptyProfileAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.profiles.actions.createAndEnterEmptyProfile',
			title: {
				value: localize('create and enter empty profile', "Create and Enter Empty Profile..."),
				original: 'Create and Enter Empty Profile...'
			},
			category: PROFILES_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.and(IsDevelopmentContext, WorkbenchStateContext.notEqualsTo('empty')),
		});
	}

	async run(accessor: ServicesAccessor) {
		const quickInputService = accessor.get(IQuickInputService);
		const userDataProfileManagementService = accessor.get(IUserDataProfileManagementService);
		const name = await quickInputService.input({
			placeHolder: localize('name', "Profile name"),
			title: localize('create and enter empty profile', "Create and Enter Empty Profile..."),
		});
		if (name) {
			await userDataProfileManagementService.createAndEnterProfile(name);
		}
	}
});

registerAction2(class ExportProfileAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.profiles.actions.exportProfile2',
			title: {
				value: localize('export profile', "Export Settings as a Profile (2)..."),
				original: 'Export Settings as a Profile as a Profile (2)...'
			},
			category: PROFILES_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.and(IsDevelopmentContext, WorkbenchStateContext.notEqualsTo('empty')),
		});
	}

	async run(accessor: ServicesAccessor) {
		const textFileService = accessor.get(ITextFileService);
		const fileDialogService = accessor.get(IFileDialogService);
		const profileService = accessor.get(IUserDataProfileWorkbenchService);
		const notificationService = accessor.get(INotificationService);

		const profileLocation = await fileDialogService.showSaveDialog({
			title: localize('export profile dialog', "Save Profile"),
			filters: PROFILE_FILTER,
			defaultUri: joinPath(await fileDialogService.defaultFilePath(), `profile.${PROFILE_EXTENSION}`),
		});

		if (!profileLocation) {
			return;
		}

		const profile = await profileService.createProfile({ skipComments: true });
		await textFileService.create([{ resource: profileLocation, value: JSON.stringify(profile), options: { overwrite: true } }]);

		notificationService.info(localize('export success', "{0}: Exported successfully.", PROFILES_CATEGORY));
	}
});

registerAction2(class ImportProfileAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.profiles.actions.importProfile2',
			title: {
				value: localize('import profile', "Import Settings from a Profile (2)..."),
				original: 'Import Settings from a Profile (2)...'
			},
			category: PROFILES_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.and(IsDevelopmentContext, WorkbenchStateContext.notEqualsTo('empty')),
		});
	}

	async run(accessor: ServicesAccessor) {
		const fileDialogService = accessor.get(IFileDialogService);
		const quickInputService = accessor.get(IQuickInputService);
		const fileService = accessor.get(IFileService);
		const requestService = accessor.get(IRequestService);
		const userDataProfileMangementService = accessor.get(IUserDataProfileManagementService);

		const disposables = new DisposableStore();
		const quickPick = disposables.add(quickInputService.createQuickPick());
		const updateQuickPickItems = (value?: string) => {
			const selectFromFileItem: IQuickPickItem = { label: localize('select from file', "Import from profile file") };
			quickPick.items = value ? [{ label: localize('select from url', "Import from URL"), description: quickPick.value }, selectFromFileItem] : [selectFromFileItem];
		};
		quickPick.title = localize('import profile quick pick title', "Import Settings from a Profile");
		quickPick.placeholder = localize('import profile placeholder', "Provide profile URL or select profile file to import");
		quickPick.ignoreFocusOut = true;
		disposables.add(quickPick.onDidChangeValue(updateQuickPickItems));
		updateQuickPickItems();
		quickPick.matchOnLabel = false;
		quickPick.matchOnDescription = false;
		disposables.add(quickPick.onDidAccept(async () => {
			quickPick.hide();
			const profile = quickPick.selectedItems[0].description ? await this.getProfileFromURL(quickPick.value, requestService) : await this.getProfileFromFileSystem(fileDialogService, fileService);
			if (profile) {
				const name = await quickInputService.input({
					placeHolder: localize('name', "Profile name"),
					title: localize('save profile as', "Save Settings Profile As..."),
				});
				if (name) {
					await userDataProfileMangementService.createAndEnterProfileFromTemplate(name, profile);
				}
			}
		}));
		disposables.add(quickPick.onDidHide(() => disposables.dispose()));
		quickPick.show();
	}

	private async getProfileFromFileSystem(fileDialogService: IFileDialogService, fileService: IFileService): Promise<IUserDataProfileTemplate | null> {
		const profileLocation = await fileDialogService.showOpenDialog({
			canSelectFolders: false,
			canSelectFiles: true,
			canSelectMany: false,
			filters: PROFILE_FILTER,
			title: localize('import profile dialog', "Import Profile"),
		});
		if (!profileLocation) {
			return null;
		}
		const content = (await fileService.readFile(profileLocation[0])).value.toString();
		const parsed = JSON.parse(content);
		return isProfile(parsed) ? parsed : null;
	}

	private async getProfileFromURL(url: string, requestService: IRequestService): Promise<IUserDataProfileTemplate | null> {
		const options = { type: 'GET', url };
		const context = await requestService.request(options, CancellationToken.None);
		if (context.res.statusCode === 200) {
			const result = await asJson(context);
			return isProfile(result) ? result : null;
		} else {
			const message = await asText(context);
			throw new Error(`Expected 200, got back ${context.res.statusCode} instead.\n\n${message}`);
		}
	}

});
