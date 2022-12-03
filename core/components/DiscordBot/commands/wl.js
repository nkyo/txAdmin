const modulename = "DiscordBot:cmd:wl";
import consts from "@core/extras/consts.js";
import logger from "@core/extras/console.js";
const { dir, log, logOk, logWarn, logError } = logger(modulename);

/**
 * Usage options:
 *  /addwl <wl req id>
 *  /addwl <license>
 *  /addwl <mention> ???
 */
export default {
  description: "Adds a players to the whitelist",
  cooldown: 5,
  async execute(message, args) {
    //Check permissions
    //TODO: generalize this to other commands?

    // const admin = globals.adminVault.getAdminByProviderUID(message.author.id);
    // if (!admin) {
    //   return await message.reply(
    //     "your Discord ID is not registered in txAdmin :face_with_monocle:"
    //   );
    // }
    // if (
    //   admin.master !== true &&
    //   !admin.permissions.includes("all_permissions") &&
    //   !admin.permissions.includes("players.whitelist")
    // ) {
    //   return await message.reply(
    //     "you do not have whitelist permissions :face_with_raised_eyebrow:"
    //   );
    // }

    //Check if whitelist is enabled
    if (!globals.playerController.config.onJoinCheckWhitelist) {
      return await message.reply(
        "**NoobGM** đang gặp vấn đề, vui lòng thử lại sau hoặc liên hệ GameMaster!"
      );
    }

    //Check usage
    if (args.length !== 1) {
      const msgLines = [
        "Vui lòng nhập mã yêu cầu mà bạn nhận được khi kết nối vào thành phố (R####).",
        "Ví dụ:",
        `\`${globals.discordBot.config.prefix}wl R1234\``,
        "Hãy liên hệ GM để được hỗ trợ nếu gặp sự cố.",
      ];
      return await message.reply(msgLines.join("\n"));
    }

    //Treat input to improve UX
    let reference = args[0];
    if (reference.length == 5) {
      reference = reference.toUpperCase();
    } else if (reference.length == 40) {
      reference = reference.toLowerCase();
    } else if (reference.length == 48) {
      reference = reference.substring(8).toLowerCase();
    }

    //Check input validity
    if (
      !consts.regexWhitelistReqID.test(reference) &&
      !/[0-9A-Fa-f]{40}/.test(reference)
    ) {
      return await message.reply(
        "Không tìm thấy mã yêu cầu, vui lòng kiểm tra hoặc liên hệ GameMaster"
      );
    }

    //Whitelist reference
    if (message.channel.id === "1031776547910189157") {
      try {
        await globals.playerController.approveWhitelist(
          reference,
          "NoobCityAutomation"
        );
      } catch (error) {
        return await message.reply(`**Lỗi:** ${error.message}`);
      }
      const logMessage = `[DISCORD][NoobCity Automation] Whitelisted ${reference}`;
      var role = message.guild.roles.cache.find(
        (role) => role.name === "Dân Cư NoobCity"
      );
      var rolerm = message.guild.roles.cache.find(
        (role) => role.name === "Dân Cư"
      );
      logOk(logMessage);
      const reactionEmoji = message.guild.emojis.cache.find(emoji => emoji.name === 'PepeSniff');
      return await message.reply(
        "Bạn đã được cấp quyền tham gia thành phố, hãy mở fiveM và kết nối vào thành phố. F8 -> connect zbzzzp ! :white_check_mark:",
        message.member.roles.add(role.id),
        message.member.roles.remove(rolerm.id),
        message.react(reactionEmoji)
      );
    }
  },
};
